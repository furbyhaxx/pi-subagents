import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentMessagingService } from "../messaging/service.js";
import { type ForeignTranscriptTailResult, readForeignTranscriptTail } from "../messaging/transcript-tail.js";
import type {
  AgentRow,
  MessagingStoreMetadata,
  MessagingTransportMode,
  PeerAccess,
} from "../messaging/types.js";
import type { Theme } from "./agent-widget.js";
import type { MessagingPanelTui } from "./blackboard-panel.js";
import {
  headerLines,
  listViewportOffset,
  PANEL_REFRESH_MS,
  paintPanelRows,
  paneBlock,
  panelContentWidth,
  printableInput,
  sanitizeTerminalText,
  singleLine,
  statusLine,
  truncateLeft,
  viewportRows,
  wrapPlain,
} from "./messaging-panel-common.js";
import { clampLine, styleWorkflowCardLines, type WorkflowCardLine } from "./workflow-card.js";

export type PanelPeer = AgentRow & { unread: number; access: PeerAccess };
type PeerService = Pick<AgentMessagingService, "panelPeers" | "getPanelInfo">;
type PeerUI = Pick<ExtensionUIContext, "custom" | "notify">;
type PanelInfo = MessagingStoreMetadata & { sessionId: string; transport: MessagingTransportMode };
type PeerView = "list" | "help" | "meta" | "tail-loading" | "tail";
type TailReason = "PE.M1" | "PE.M2" | "PE.M3" | "PE.M4" | "PE.M5" | "PE.M6";

export interface PeersPanelInitial { peers: PanelPeer[]; info: PanelInfo }
export interface PeersPanelActions {
  openLocal(agentId: string): Promise<"opened" | "missing" | "no-session">;
}

const REASONS: Record<TailReason, string> = {
  "PE.M1": "This agent has no live session in this process, so there is nothing to open.",
  "PE.M2": "This agent belongs to another session and records no session file.",
  "PE.M3": "The session file no longer exists.",
  "PE.M4": "The session file cannot be read.",
  "PE.M5": "The recorded session path is not a file.",
  "PE.M6": "The session file was replaced or truncated while it was being read. Press r to try again.",
};

function messageOf(error: unknown): string {
  return singleLine(error instanceof Error ? error.message : String(error));
}

function identity(peer: PanelPeer): string { return singleLine(peer.alias ?? peer.handle ?? peer.agentId); }

function uniquePrefix(peer: PanelPeer, collision: readonly PanelPeer[]): string {
  const floor = Math.min(6, peer.sessionId.length);
  for (let length = floor; length <= peer.sessionId.length; length++) {
    const prefix = peer.sessionId.slice(0, length);
    if (collision.every(other => other === peer || !other.sessionId.startsWith(prefix))) return prefix;
  }
  return peer.sessionId;
}

export function peerDisplayIdentities(peers: readonly PanelPeer[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const peer of peers) {
    const base = identity(peer);
    const collision = peers.filter(other => identity(other) === base);
    result.set(peer.agentId, collision.length > 1 ? `${base}@${uniquePrefix(peer, collision)}` : base);
  }
  return result;
}

function sortPeers(peers: readonly PanelPeer[], sessionId: string): PanelPeer[] {
  return [...peers].sort((a, b) => {
    const own = Number(b.sessionId === sessionId) - Number(a.sessionId === sessionId);
    if (own !== 0) return own;
    const session = a.sessionId.localeCompare(b.sessionId);
    if (session !== 0) return session;
    const main = Number(b.kind === "main") - Number(a.kind === "main");
    return main || identity(a).localeCompare(identity(b));
  });
}

function swissTime(timestamp: number): string {
  return new Intl.DateTimeFormat("de-CH", {
    timeZone: "Europe/Zurich",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(timestamp);
}

function tailFailureReason(result: Extract<ForeignTranscriptTailResult, { ok: false }>): TailReason | undefined {
  if (result.reason === "missing") return "PE.M3";
  if (result.reason === "unreadable") return "PE.M4";
  if (result.reason === "not-file") return "PE.M5";
  if (result.reason === "changed") return "PE.M6";
  return undefined;
}

export class PeersPanel implements Component {
  private peers: PanelPeer[];
  private info: PanelInfo;
  private selectedId: string | undefined;
  private filter = "";
  private filterBeforeEdit = "";
  private filterEditing = false;
  private view: PeerView = "list";
  private beforeHelp: { view: Exclude<PeerView, "help">; scroll: number; following: boolean } | undefined;
  private listOffset = 0;
  private reason: TailReason | undefined;
  private tail: Extract<ForeignTranscriptTailResult, { ok: true }> | undefined;
  private scroll = 0;
  private following = true;
  private note: { text: string; color: "warning" | "error" } | undefined;
  private snapshotAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tailTimer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private busy = false;
  private closed = false;
  private renderWidth = 74;
  private bodyRows = 1;
  private scrollMax = 0;

  constructor(
    private readonly tui: MessagingPanelTui,
    private readonly theme: Theme,
    private readonly done: (result: "main" | undefined) => void,
    private readonly service: PeerService,
    private readonly ui: PeerUI,
    private readonly actions: PeersPanelActions,
    initial: PeersPanelInitial,
  ) {
    this.peers = sortPeers(initial.peers, initial.info.sessionId);
    this.info = initial.info;
    this.selectedId = this.peers[0]?.agentId;
    this.schedule();
  }

  handleInput(data: string): void {
    if (this.busy || this.closed) return;
    if (this.filterEditing) {
      if (matchesKey(data, "escape")) { this.filter = this.filterBeforeEdit; this.filterEditing = false; }
      else if (matchesKey(data, "enter")) this.filterEditing = false;
      else if (matchesKey(data, "backspace")) this.filter = this.filter.slice(0, -1);
      else { const printable = printableInput(data); if (printable) this.filter += printable; }
      this.reconcile(); this.tui.requestRender(); return;
    }
    if (this.note) this.note = undefined;
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "q")) { this.close(); return; }
    if (matchesKey(data, "escape")) {
      if (this.view === "help") this.leaveHelp();
      else if (this.filter) this.filter = "";
      else if (this.view !== "list") this.leaveDetail();
      else { this.close(); return; }
      this.tui.requestRender(); return;
    }
    if (matchesKey(data, "?")) {
      if (this.view === "help") this.leaveHelp();
      else this.enterHelp();
      this.tui.requestRender(); return;
    }
    if (matchesKey(data, "/") && this.view === "list") { this.filterEditing = true; this.filterBeforeEdit = this.filter; this.tui.requestRender(); return; }
    if (matchesKey(data, "r")) {
      if (this.view === "tail" || this.view === "meta") void this.retryDetail();
      else void this.refresh();
      return;
    }
    if (matchesKey(data, "enter") && this.view === "list") { void this.openSelected(); return; }
    this.render(this.renderWidth + 6);
    const page = Math.max(1, this.bodyRows - 1);
    const down = matchesKey(data, "down") || matchesKey(data, "j");
    const up = matchesKey(data, "up") || matchesKey(data, "k");
    const pageDown = matchesKey(data, "pageDown") || matchesKey(data, "shift+down");
    const pageUp = matchesKey(data, "pageUp") || matchesKey(data, "shift+up");
    const top = matchesKey(data, "g") || matchesKey(data, "home");
    const bottom = matchesKey(data, "shift+g") || matchesKey(data, "end");
    if (!(down || up || pageDown || pageUp || top || bottom)) return;
    if (this.view === "list") {
      const visible = this.visiblePeers();
      const current = visible.findIndex(peer => peer.agentId === this.selectedId);
      const delta = down ? 1 : up ? -1 : pageDown ? page : pageUp ? -page : 0;
      const index = top ? 0 : bottom ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, current + delta));
      this.selectedId = visible[index]?.agentId;
    } else {
      this.scroll = top ? 0 : bottom ? this.scrollMax : Math.max(0, Math.min(this.scrollMax, this.scroll + (down ? 1 : up ? -1 : pageDown ? page : -page)));
      this.following = this.scroll >= this.scrollMax;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const contentWidth = panelContentWidth(width);
    this.renderWidth = contentWidth;
    const sessions = new Set(this.peers.map(peer => peer.sessionId)).size;
    const header = headerLines({ name: "Peers", info: this.info, count: `${sessions} session${sessions === 1 ? "" : "s"}`, width: contentWidth });
    const geometry = viewportRows(this.tui.terminal.rows, header.length);
    this.bodyRows = geometry.bodyRows;
    let body: WorkflowCardLine[];
    let hint = "";
    if (this.view === "help") {
      const help = [
        "↑↓ / j k   move or scroll", "PgUp/PgDn   page", "g/G          first / last", "Enter        open selected peer", "/            filter", "r            refresh", "?            keys", "Esc          back", "q / ctrl+c   close", "Foreign agents are read-only from here.",
      ].map(text => [{ text, color: "dim" as const }]);
      body = this.scrollRows(help, geometry.bodyRows);
      hint = "↑↓ scroll · esc back";
    } else if (this.view === "tail-loading") {
      body = [[{ text: "Reading the session file…", color: "muted" }]];
      hint = "↑↓ scroll · r refresh · esc back";
    } else if (this.view === "tail") {
      const layout = this.tailLayout(contentWidth, header.length);
      const lines = this.tailBody(contentWidth);
      this.bodyRows = layout.bodyRows;
      this.scrollMax = Math.max(0, lines.length - layout.bodyRows);
      this.scroll = this.following ? this.scrollMax : Math.min(this.scroll, this.scrollMax);
      const shown = lines.slice(this.scroll, this.scroll + layout.bodyRows);
      if (lines.length === 0) shown.push([{ text: "The session file is empty.", color: "muted" }]);
      while (shown.length < layout.bodyRows) shown.push([]);
      const indicator = `${lines.length ? this.scroll + 1 : 0}-${Math.min(lines.length, this.scroll + layout.bodyRows)}/${lines.length}`;
      body = [...layout.header, ...shown, [{ text: indicator.padStart(contentWidth), color: "dim" }]];
      hint = "↑↓ scroll · r refresh · esc back";
    } else if (this.view === "meta") {
      body = this.scrollRows(this.metadataRows(contentWidth), geometry.bodyRows);
      hint = "↑↓ scroll · r refresh · esc back";
    } else {
      const visible = this.visiblePeers();
      this.listOffset = listViewportOffset(this.listOffset, visible.findIndex(peer => peer.agentId === this.selectedId), visible.length, geometry.bodyRows);
      const alone = this.peers.length === 1 && this.peers[0]?.access === "main";
      const rows = alone
        ? [[{ text: "  No peers yet. Agents appear here as soon as they register on the bus.", color: "muted" as const }]]
        : visible.length === 0
          ? [[{ text: `  No peer matches "${singleLine(this.filter)}".`, color: "muted" as const }]]
          : this.peerRows(visible, geometry.framed ? Math.max(1, contentWidth - 2) : contentWidth).slice(this.listOffset, this.listOffset + geometry.bodyRows);
      body = paneBlock({ panes: [{ title: this.filter ? `Peers · ${visible.length}/${this.peers.length}` : "Peers", rows, focused: true }], width: contentWidth, bodyRows: geometry.bodyRows, framed: geometry.framed });
      const peer = this.selectedPeer();
      hint = peer?.access === "main"
        ? "⏎ back to your conversation · / filter · ? keys · esc close"
        : peer?.access === "local"
          ? "⏎ open conversation · / filter · ? keys · esc close"
          : "⏎ read-only file tail · / filter · ? keys · esc close";
    }
    const status = this.filterEditing
      ? [{ text: `/ ${this.filter}▌`, color: "accent" as const }]
      : this.note ? statusLine(`⚠ ${this.note.text}`, contentWidth, this.note.color) : statusLine(hint, contentWidth);
    return paintPanelRows(styleWorkflowCardLines([...header, ...body, status].map(line => clampLine(line, contentWidth)), this.theme), width);
  }

  invalidate(): void {}
  dispose(): void {
    this.closed = true; this.generation++; this.beforeHelp = undefined;
    if (this.timer) clearTimeout(this.timer);
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.timer = undefined; this.tailTimer = undefined;
    this.abort?.abort(); this.abort = undefined;
  }

  private close(result?: "main"): void { if (this.closed) return; this.dispose(); this.done(result); }
  private enterHelp(): void {
    if (this.view === "help") return;
    this.beforeHelp = { view: this.view, scroll: this.scroll, following: this.following };
    this.generation++;
    this.abort?.abort(); this.abort = undefined;
    if (this.timer) clearTimeout(this.timer);
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.timer = undefined; this.tailTimer = undefined;
    this.view = "help"; this.scroll = 0;
  }
  private leaveHelp(): void {
    const previous = this.beforeHelp;
    if (this.closed || !previous) return;
    this.beforeHelp = undefined;
    this.view = previous.view; this.scroll = previous.scroll; this.following = previous.following;
    if (this.view === "list") void this.refresh();
    else void this.retryDetail();
  }
  private scrollRows(rows: WorkflowCardLine[], viewport: number): WorkflowCardLine[] {
    this.scrollMax = Math.max(0, rows.length - viewport);
    this.scroll = Math.min(this.scroll, this.scrollMax);
    return rows.slice(this.scroll, this.scroll + viewport);
  }
  private selectedPeer(): PanelPeer | undefined { return this.peers.find(peer => peer.agentId === this.selectedId); }
  private visiblePeers(): PanelPeer[] {
    if (!this.filter) return this.peers;
    const query = this.filter.toLowerCase();
    return this.peers.filter(peer => [peer.handle, peer.alias, peer.description, peer.agentId, peer.sessionId, peer.sessionId === this.info.sessionId ? "this session" : `session ${peer.sessionId.slice(0, 6)}`].some(value => value?.toLowerCase().includes(query)));
  }
  private reconcile(): void { const visible = this.visiblePeers(); if (!visible.some(peer => peer.agentId === this.selectedId)) this.selectedId = visible[0]?.agentId; }
  private peerRows(peers: readonly PanelPeer[], width: number): WorkflowCardLine[] {
    const identities = peerDisplayIdentities(peers);
    const statusGlyph: Record<PanelPeer["status"], string> = { running: "●", idle: "○", queued: "◌", settled: "✔", gone: "✘" };
    return peers.map(peer => {
      const selected = peer.agentId === this.selectedId;
      const unread = peer.unread > 0 ? `${peer.unread} unread` : "";
      const session = peer.sessionId === this.info.sessionId ? "this session" : `session ${peer.sessionId.slice(0, 6)}`;
      const id = identities.get(peer.agentId) ?? identity(peer);
      const fields = width >= 62 ? `${peer.status.padEnd(8)} ${session.padEnd(14)} ${singleLine(peer.description ?? "")}` : width >= 42 ? `${peer.status.padEnd(8)} ${session}` : width >= 30 ? session : "";
      const left: WorkflowCardLine = [
        { text: ` ${selected ? "❯" : " "} `, color: selected ? "accent" : "dim" },
        { text: `${statusGlyph[peer.status]} `, color: peer.status === "running" ? "accent" : peer.status === "settled" ? "success" : peer.status === "gone" ? "error" : peer.status === "idle" ? "muted" : "dim" },
        { text: id, color: selected ? "accent" : "muted", bold: selected },
        ...(fields ? [{ text: `  ${fields}`, color: "dim" as const }] : []),
      ];
      if (!unread) return clampLine(left, width);
      const rightWidth = visibleWidth(unread);
      const clampedLeft = clampLine(left, Math.max(0, width - rightWidth - 1));
      const used = clampedLeft.reduce((total, segment) => total + visibleWidth(segment.text), 0);
      return [...clampedLeft, { text: " ".repeat(Math.max(1, width - used - rightWidth)) }, { text: unread, color: "accent" }];
    });
  }
  private metadataRows(width: number): WorkflowCardLine[] {
    const peer = this.selectedPeer();
    if (!peer) return [];
    const rows: WorkflowCardLine[] = [[{ text: singleLine(`${identity(peer)} · ${peer.sessionId === this.info.sessionId ? "this session" : `session ${peer.sessionId.slice(0, 6)}`}`), color: "muted", bold: true }]];
    const add = (label: string, value: string, color: "muted" | "warning" = "muted") => {
      const wrapped = wrapPlain(value, Math.max(1, width - 10));
      rows.push([{ text: `${label.padEnd(9)} `, color: "dim" }, { text: wrapped[0] ?? "", color }]);
      for (const continuation of wrapped.slice(1)) rows.push([{ text: " ".repeat(10) }, { text: continuation, color }]);
    };
    add("status", peer.status); add("kind", peer.kind); add("type", peer.type); add("unread", String(peer.unread)); add("pid", String(peer.pid)); add("last seen", `${swissTime(peer.seenAt)} (Europe/Zurich)`);
    if (peer.sessionFile) add("file", truncateLeft(singleLine(peer.sessionFile), Math.max(1, width - 10)));
    if (this.reason) add("reason", REASONS[this.reason], this.reason === "PE.M1" || this.reason === "PE.M2" ? "muted" : "warning");
    return rows;
  }
  private tailLayout(width: number, panelHeaderRows: number): { header: WorkflowCardLine[]; bodyRows: number } {
    const peer = this.selectedPeer();
    const available = Math.max(1, Math.floor(this.tui.terminal.rows * 0.7) - panelHeaderRows - 2);
    if (!peer) return { header: [], bodyRows: available };
    const suffix = " · File tail";
    const prefix = singleLine(`${identity(peer)} · session ${peer.sessionId.slice(0, 6)}`);
    const title = `${truncateToWidth(prefix, Math.max(0, width - visibleWidth(suffix)), "…")}${suffix}`;
    const explanation = wrapPlain("Raw file order, newest records last. Branches are not reconstructed and this is not a conversation.", width);
    const header: WorkflowCardLine[] = [[{ text: title, color: "muted", bold: true }]];
    // The short host must retain at least one record row, not just explanatory chrome.
    if (available >= explanation.length + 3) {
      header.push(...explanation.map(text => [{ text, color: "dim" as const }]), []);
    } else header.push([{ text: "Raw file order · newest last", color: "dim" }]);
    return { header, bodyRows: Math.max(1, available - header.length) };
  }
  private tailBody(width: number): WorkflowCardLine[] {
    if (!this.tail) return [];
    const result: WorkflowCardLine[] = [];
    if (this.tail.truncated) result.push([{ text: "Older records were not read.", color: "dim" }]);
    if (this.tail.skippedLines > 0) result.push([{ text: `${this.tail.skippedLines} record${this.tail.skippedLines === 1 ? "" : "s"} skipped — too large or unreadable.`, color: "dim" }]);
    for (const source of this.tail.lines) {
      for (const line of sanitizeTerminalText(source, true).flatMap(text => wrapTextWithAnsi(text || " ", Math.max(1, width)))) result.push([{ text: line }]);
    }
    return result;
  }
  private schedule(): void {
    if (this.closed || this.busy || this.timer || this.view !== "list") return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, PANEL_REFRESH_MS);
    this.timer.unref?.();
  }
  private async refresh(): Promise<void> {
    if (this.closed || this.busy || this.view !== "list") return;
    const generation = this.generation;
    try {
      const peers = this.service.panelPeers(); const info = this.service.getPanelInfo();
      if (this.closed || generation !== this.generation) return;
      this.peers = sortPeers(peers, info.sessionId); this.info = info; this.snapshotAt = Date.now(); this.reconcile(); this.tui.requestRender();
    } catch (error) {
      this.note = { text: `Refresh failed: ${messageOf(error)}. Showing the snapshot from ${swissTime(this.snapshotAt)}.`, color: "error" }; this.tui.requestRender();
    } finally { this.schedule(); }
  }
  private async openSelected(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    this.busy = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const generation = this.generation;
    try {
      let peers: PanelPeer[];
      try { peers = this.service.panelPeers(); }
      catch (error) { this.note = { text: `Refresh failed: ${messageOf(error)}. Showing the snapshot from ${swissTime(this.snapshotAt)}.`, color: "error" }; return; }
      const current = peers.find(peer => peer.agentId === id);
      if (!current) { this.peers = sortPeers(peers, this.info.sessionId); this.reconcile(); this.ui.notify("That peer is no longer on the bus.", "warning"); return; }
      this.peers = sortPeers(peers, this.info.sessionId); this.selectedId = id;
      if (current.access === "main") { this.close("main"); return; }
      if (current.access === "local") {
        const result = await this.actions.openLocal(id);
        if (this.closed || generation !== this.generation) return;
        if (result === "missing") { this.ui.notify("That agent is no longer running in this session.", "warning"); await this.refresh(); }
        else if (result === "no-session") { this.reason = "PE.M1"; this.view = "meta"; }
        return;
      }
      if (!current.sessionFile) { this.reason = "PE.M2"; this.view = "meta"; return; }
      this.busy = false;
      this.following = true;
      await this.readTail(current);
    } finally {
      this.busy = false;
      if (!this.closed) {
        if (this.view === "list") { await this.refresh(); this.schedule(); }
        this.tui.requestRender();
      }
    }
  }
  private async readTail(peer: PanelPeer): Promise<void> {
    if (!peer.sessionFile) { this.reason = "PE.M2"; this.view = "meta"; return; }
    this.abort?.abort();
    const controller = new AbortController(); this.abort = controller;
    const generation = ++this.generation;
    if (this.view !== "tail") { this.view = "tail-loading"; this.tui.requestRender(); }
    const atBottom = this.following;
    let result: ForeignTranscriptTailResult;
    try { result = await readForeignTranscriptTail(peer.sessionFile, controller.signal); }
    catch (error) { result = { ok: false, reason: "unreadable", message: messageOf(error) }; }
    finally { if (this.abort === controller) this.abort = undefined; }
    if (this.closed || generation !== this.generation || result.ok === false && result.reason === "aborted") return;
    if (!result.ok) { this.reason = tailFailureReason(result); if (this.reason) this.view = "meta"; this.tui.requestRender(); return; }
    this.tail = result; this.reason = undefined; this.view = "tail";

    this.following = atBottom;
    this.scheduleTail(); this.tui.requestRender();
  }
  private scheduleTail(): void {
    if (this.closed || this.view !== "tail" || this.tailTimer) return;
    this.tailTimer = setTimeout(() => { this.tailTimer = undefined; void this.retryDetail(); }, PANEL_REFRESH_MS);
    this.tailTimer.unref?.();
  }
  private async retryDetail(): Promise<void> {
    if (this.closed || this.view === "help") return;
    const peer = this.selectedPeer();
    if (!peer?.sessionFile || this.abort) return;
    if (this.tailTimer) clearTimeout(this.tailTimer); this.tailTimer = undefined;
    await this.readTail(peer);
  }
  private leaveDetail(): void {
    this.generation++; this.abort?.abort(); this.abort = undefined;
    if (this.tailTimer) clearTimeout(this.tailTimer); this.tailTimer = undefined;
    this.view = "list"; this.reason = undefined; this.scroll = 0; this.schedule();
  }
}

export async function showPeersPanel(ui: PeerUI, service: PeerService, actions: PeersPanelActions): Promise<"main" | undefined> {
  let initial: PeersPanelInitial;
  try { initial = { peers: service.panelPeers(), info: service.getPanelInfo() }; }
  catch (error) { ui.notify(`Could not open peers: ${messageOf(error)}`, "error"); return undefined; }
  return await ui.custom<"main" | undefined>((tui, theme, _keys, done) => new PeersPanel(tui, theme, done, service, ui, actions, initial), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
  });
}
