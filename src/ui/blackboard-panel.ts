import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  type OverlayHandle,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentMessagingService } from "../messaging/service.js";
import type {
  BlackboardEntry,
  BlackboardLogEntry,
  MessagingStoreMetadata,
  MessagingTransportMode,
  OperatorDeleteResult,
  OperatorPutResult,
} from "../messaging/types.js";
import type { Theme } from "./agent-widget.js";
import { type BlackboardDialogTarget, showBlackboardAcknowledgement, showBlackboardValueEditor } from "./blackboard-dialogs.js";
import {
  headerLines,
  listViewportOffset,
  PANEL_BREAKPOINT,
  PANEL_REFRESH_MS,
  paintPanelRows,
  paneBlock,
  panelContentWidth,
  printableInput,
  sanitizeTerminalText,
  showPrefillInput,
  singleLine,
  statusLine,
  truncateLeft,
  viewportRows,
  wrapPlain,
} from "./messaging-panel-common.js";
import { clampLine, styleWorkflowCardLines, type WorkflowCardLine } from "./workflow-card.js";

export type BlackboardLevel = "topics" | "keys" | "entry";
type BlackboardLayer = "value" | "help" | undefined;

type BlackboardService = Pick<AgentMessagingService,
  "boardList" | "boardRecentLog" | "getPanelInfo" | "operatorPut" | "operatorDelete" | "operatorExpire"
>;
type BlackboardUI = Pick<ExtensionUIContext, "custom" | "select" | "notify">;

type PanelInfo = MessagingStoreMetadata & { sessionId: string; transport: MessagingTransportMode };

export interface BlackboardPanelInitial {
  entries: BlackboardEntry[];
  info: PanelInfo;
}

export interface MessagingPanelTui {
  readonly terminal: { readonly rows: number };
  requestRender(): void;
}

interface TopicGroup {
  topic: string;
  entries: BlackboardEntry[];
  updatedAt: number;
}

function messageOf(error: unknown): string {
  return singleLine(error instanceof Error ? error.message : String(error));
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function groups(entries: readonly BlackboardEntry[]): TopicGroup[] {
  const map = new Map<string, BlackboardEntry[]>();
  for (const entry of entries) {
    const existing = map.get(entry.topic);
    if (existing) existing.push(entry);
    else map.set(entry.topic, [entry]);
  }
  return [...map].map(([topic, topicEntries]) => ({
    topic,
    entries: topicEntries.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)),
    updatedAt: Math.max(...topicEntries.map(entry => entry.updatedAt)),
  })).sort((a, b) => b.updatedAt - a.updatedAt || a.topic.localeCompare(b.topic));
}

function swissDate(timestamp: number, now: number, suffix: boolean): string {
  const date = new Date(timestamp);
  const current = new Date(now);
  const parts = new Intl.DateTimeFormat("de-CH", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", dateStyle: "short" }).format(date)
    === new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", dateStyle: "short" }).format(current);
  const sameYear = get("year") === new Intl.DateTimeFormat("en", { timeZone: "Europe/Zurich", year: "numeric" }).format(current);
  const time = `${get("hour")}:${get("minute")}:${get("second")}`;
  const shown = sameDay ? time : sameYear ? `${get("day")}.${get("month")}. ${time}` : `${get("day")}.${get("month")}.${get("year")} ${time}`;
  return suffix ? `${shown} (Europe/Zurich)` : shown;
}

function relative(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function detailRows(entry: BlackboardEntry, width: number, sessionId: string, now: number, panelWidth: number, full = false): WorkflowCardLine[] {
  const rows: WorkflowCardLine[] = [];
  const suffix = panelWidth >= 48;
  const session = entry.authorSessionId === null
    ? "session unknown"
    : entry.authorSessionId === sessionId ? "this session" : `session ${entry.authorSessionId.slice(0, 6)}`;
  const field = (label: string, value: string, color: "muted" | "warning" = "muted") => {
    const wrapped = wrapPlain(value, Math.max(1, width - 10));
    rows.push([{ text: `${label.padEnd(8)} `, color: "dim" }, { text: wrapped[0] ?? "", color }]);
    for (const continuation of wrapped.slice(1)) rows.push([{ text: " ".repeat(9) }, { text: continuation, color }]);
  };
  field("author", `${entry.author} · ${session}`);
  if (entry.authorSessionId === null) rows.push([{ text: " ".repeat(9) }, { text: "Writing session was not recorded.", color: "dim" }]);
  if (entry.authorAgentId !== null && panelWidth >= PANEL_BREAKPOINT) field("agent", entry.authorAgentId);
  field("revision", String(entry.revision));
  field("created", swissDate(entry.createdAt, now, suffix));
  field("updated", swissDate(entry.updatedAt, now, suffix));
  if (entry.expiresAt === null) field("ttl", "—");
  else {
    const left = Math.max(0, entry.expiresAt - now);
    const amount = left < 60_000 ? `${Math.floor(left / 1000)}s` : left < 3_600_000 ? `${Math.floor(left / 60_000)}m` : left < 86_400_000 ? `${Math.floor(left / 3_600_000)}h` : `${Math.floor(left / 86_400_000)}d`;
    field("ttl", `${amount} left · expires ${swissDate(entry.expiresAt, now, false)}`, left < 60_000 ? "warning" : "muted");
  }
  rows.push([{ text: "value", color: "dim" }]);
  const valueLines = sanitizeTerminalText(valueText(entry.value), true).flatMap(line => wrapTextWithAnsi(line || " ", Math.max(1, width - 2)));
  const capped = full ? valueLines : valueLines.slice(0, 200);
  for (const line of capped) rows.push([{ text: `  ${line}` }]);
  if (!full && valueLines.length > 200) rows.push([{ text: "… truncated. Press o for the full value.", color: "dim" }]);
  return rows;
}

export class BlackboardPanel implements Component {
  private entries: BlackboardEntry[];
  private info: PanelInfo;
  private level: BlackboardLevel = "topics";
  private layer: BlackboardLayer;
  private selectedTopic: string | undefined;
  private selectedKey: string | undefined;
  private oldTopicIndex = 0;
  private oldKeyIndex = 0;
  private topicOffset = 0;
  private keyOffset = 0;
  private filter = "";
  private filterEditing = false;
  private filterBeforeEdit = "";
  private log = false;
  private logs: BlackboardLogEntry[] = [];
  private logError: string | undefined;
  private scroll = 0;
  private scrollMax = 0;
  private renderWidth = 80;
  private bodyRows = 1;
  private note: { text: string; color: "warning" | "error" } | undefined;
  private snapshotAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private closed = false;
  private generation = 0;
  private suppressGoneNote = false;

  constructor(
    private readonly tui: MessagingPanelTui,
    private readonly theme: Theme,
    private readonly done: (result: undefined) => void,
    private readonly service: BlackboardService,
    private readonly ui: BlackboardUI,
    initial: BlackboardPanelInitial,
    private readonly overlay: () => Pick<OverlayHandle, "setHidden" | "focus"> | undefined = () => undefined,
  ) {
    this.entries = initial.entries;
    this.info = initial.info;
    this.selectedTopic = groups(this.entries)[0]?.topic;
    this.selectedKey = this.topicEntries(this.selectedTopic)[0]?.key;
    this.schedule();
  }

  handleInput(data: string): void {
    if (this.busy || this.closed) return;
    if (this.filterEditing) {
      if (matchesKey(data, "escape")) {
        this.filter = this.filterBeforeEdit;
        this.filterEditing = false;
      } else if (matchesKey(data, "enter")) this.filterEditing = false;
      else if (matchesKey(data, "backspace")) this.filter = this.filter.slice(0, -1);
      else {
        const printable = printableInput(data);
        if (printable) this.filter += printable;
      }
      this.reconcileSelection();
      this.tui.requestRender();
      return;
    }
    if (this.note) this.note = undefined;
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "q")) { this.close(); return; }
    if (matchesKey(data, "escape")) {
      if (this.layer) this.layer = undefined;
      else if (this.log) this.log = false;
      else if (this.filter) { this.filter = ""; this.note = { text: "Filter cleared.", color: "warning" }; }
      else if (this.level === "entry") this.level = "keys";
      else if (this.level === "keys") this.level = "topics";
      else { this.close(); return; }
      this.tui.requestRender();
      return;
    }
    if (this.layer && !(["?", "j", "k", "g", "shift+g", "down", "up", "pageDown", "pageUp", "shift+down", "shift+up", "home", "end"] as const).some(key => matchesKey(data, key))) return;
    if (matchesKey(data, "left")) {
      if (this.level === "entry") this.level = "keys";
      else if (this.level === "keys") this.level = "topics";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "/")) {
      this.filterEditing = true;
      this.filterBeforeEdit = this.filter;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "?")) { this.layer = this.layer === "help" ? undefined : "help"; this.scroll = 0; this.tui.requestRender(); return; }
    if (matchesKey(data, "l")) { this.log = !this.log; this.scroll = 0; if (this.log) void this.refreshLog(); this.tui.requestRender(); return; }
    if (matchesKey(data, "r")) { void this.refresh(); return; }
    if (matchesKey(data, "n")) { void this.createEntry(); return; }
    if (!this.layer && this.level !== "topics" && matchesKey(data, "o") && this.selectedEntry()) { this.layer = "value"; this.scroll = 0; this.tui.requestRender(); return; }
    if (!this.layer && this.level !== "topics" && matchesKey(data, "e")) { void this.editEntry(); return; }
    if (!this.layer && this.level !== "topics" && matchesKey(data, "d")) { void this.removeEntry("delete"); return; }
    if (!this.layer && this.level !== "topics" && matchesKey(data, "x")) { void this.removeEntry("expire"); return; }

    this.render(this.renderWidth);
    const page = Math.max(1, this.bodyRows - 1);
    const down = matchesKey(data, "down") || matchesKey(data, "j");
    const up = matchesKey(data, "up") || matchesKey(data, "k");
    const pageDown = matchesKey(data, "pageDown") || matchesKey(data, "shift+down");
    const pageUp = matchesKey(data, "pageUp") || matchesKey(data, "shift+up");
    const top = matchesKey(data, "g") || matchesKey(data, "home");
    const bottom = matchesKey(data, "shift+g") || matchesKey(data, "end");
    if (this.layer || this.log || this.level === "entry") {
      if (down || pageDown || bottom) this.scroll = bottom ? this.scrollMax : Math.min(this.scrollMax, this.scroll + (pageDown ? page : 1));
      else if (up || pageUp || top) this.scroll = top ? 0 : Math.max(0, this.scroll - (pageUp ? page : 1));
      else if ((matchesKey(data, "enter") || matchesKey(data, "right")) && this.log) { this.log = false; if (this.level === "keys") this.level = "entry"; }
      else return;
      this.tui.requestRender();
      return;
    }
    if (down || up || pageDown || pageUp || top || bottom) {
      const delta = down ? 1 : up ? -1 : pageDown ? page : pageUp ? -page : 0;
      if (this.level === "topics") {
        const visible = this.visibleTopics();
        const index = top ? 0 : bottom ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, visible.findIndex(topic => topic.topic === this.selectedTopic) + delta));
        this.selectedTopic = visible[index]?.topic;
        this.selectedKey = this.visibleKeys(this.selectedTopic)[0]?.key;
        if (this.log) void this.refreshLog();
      } else {
        const visible = this.visibleKeys(this.selectedTopic);
        const index = top ? 0 : bottom ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, visible.findIndex(entry => entry.key === this.selectedKey) + delta));
        this.selectedKey = visible[index]?.key;
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      if (this.log) this.log = false;
      if (this.level === "topics" && this.selectedTopic) this.level = "keys";
      else if (this.level === "keys" && this.selectedEntry()) this.level = "entry";
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    this.renderWidth = width;
    const contentWidth = panelContentWidth(width);
    const now = Date.now();
    const header = headerLines({ name: "Blackboard", info: this.info, count: `${groups(this.entries).length} topics`, width: contentWidth });
    const geometry = viewportRows(this.tui.terminal.rows, header.length);
    this.bodyRows = geometry.bodyRows;
    let body: WorkflowCardLine[];
    let hint: string;
    if (this.layer === "value") {
      const entry = this.selectedEntry();
      const lines: WorkflowCardLine[] = entry ? [
        [{ text: truncateLeft(`${singleLine(entry.topic)}/${singleLine(entry.key)}`, contentWidth), color: "muted", bold: true }],
        [{ text: "Value is shown as plain text so the terminal can select and copy it.", color: "dim" }],
        [],
        ...sanitizeTerminalText(valueText(entry.value), true).flatMap(line => wrapTextWithAnsi(line || " ", contentWidth).map(text => [{ text }] satisfies WorkflowCardLine)),
      ] : [];
      body = this.scrollRows(lines, geometry.bodyRows);
      hint = "↑↓ scroll · esc back";
    } else if (this.layer === "help") {
      const help = [
        "↑↓ / j k   move or scroll", "PgUp/PgDn   page", "g/G          first / last", "Enter/→      descend", "Esc/←        back", "/            filter", "l            log", "o            full value", "n            new", "e            edit", "d            delete", "x            expire", "r            refresh", "?            keys", "q / ctrl+c   close", "ctrl+o (editor) full target", "ctrl+g (editor) unavailable in this host", `Store: ${this.info.databasePath}`,
      ].map(text => [{ text, color: "dim" as const }]);
      body = this.scrollRows(help, geometry.bodyRows);
      hint = "↑↓ scroll · esc back";
    } else {
      const wide = width >= PANEL_BREAKPOINT && geometry.framed;
      const singleWidth = geometry.framed ? Math.max(1, contentWidth - 2) : contentWidth;
      const leftWidth = wide ? Math.min(28, Math.max(16, Math.floor((contentWidth - 3) * 0.38))) : singleWidth;
      const rightWidth = wide ? Math.max(1, contentWidth - leftWidth - 3) : singleWidth;
      const topics = this.visibleTopics();
      const keys = this.visibleKeys(this.selectedTopic);
      this.topicOffset = listViewportOffset(this.topicOffset, topics.findIndex(topic => topic.topic === this.selectedTopic), topics.length, geometry.bodyRows);
      this.keyOffset = listViewportOffset(this.keyOffset, keys.findIndex(entry => entry.key === this.selectedKey), keys.length, geometry.bodyRows);
      const topicRows = this.topicRows(leftWidth).slice(this.topicOffset, this.topicOffset + geometry.bodyRows);
      const keyRows = this.keyRows(wide && this.level === "topics" ? rightWidth : leftWidth).slice(this.keyOffset, this.keyOffset + geometry.bodyRows);
      const detail = this.selectedEntry() ? detailRows(this.selectedEntry()!, rightWidth, this.info.sessionId, now, width) : [[{ text: "No live entries in this topic.", color: "muted" as const }]];
      const logRows = this.logRows(wide ? rightWidth : singleWidth);
      const shownLog = this.log ? this.scrollRows(logRows, geometry.bodyRows) : [];
      const shownDetail = !this.log && this.level === "entry" ? this.scrollRows(detail, geometry.bodyRows) : detail;
      let panes: { title: string; rows: WorkflowCardLine[]; focused: boolean }[];
      if (this.log) {
        const title = this.level === "topics" ? "Log · all topics" : `Log · ${this.selectedTopic ?? ""}`;
        panes = wide ? [
          { title: this.level === "topics" ? this.topicTitle() : this.keyTitle(), rows: this.level === "topics" ? topicRows : keyRows, focused: false },
          { title, rows: shownLog, focused: true },
        ] : [{ title, rows: shownLog, focused: true }];
      } else if (this.entries.length === 0) {
        panes = [{ title: "Topics", rows: [[{ text: "  The board is empty. Press n to publish an operator entry.", color: "muted" }]], focused: true }];
      } else if (this.visibleTopics().length === 0) {
        panes = [{ title: this.topicTitle(), rows: [[{ text: `  No topic or key matches "${singleLine(this.filter)}".`, color: "muted" }]], focused: true }];
      } else if (!wide) {
        panes = this.level === "topics"
          ? [{ title: this.topicTitle(), rows: topicRows, focused: true }]
          : this.level === "keys"
            ? [{ title: this.keyTitle(), rows: keyRows, focused: true }]
            : [{ title: this.detailTitle(singleWidth), rows: shownDetail, focused: true }];
      } else if (this.level === "topics") panes = [
        { title: this.topicTitle(), rows: topicRows, focused: true },
        { title: this.keyTitle(), rows: keyRows, focused: false },
      ];
      else panes = [
        { title: this.keyTitle(), rows: keyRows, focused: this.level === "keys" },
        { title: this.detailTitle(rightWidth), rows: shownDetail, focused: this.level === "entry" },
      ];
      body = paneBlock({ panes, width: contentWidth, bodyRows: geometry.bodyRows, framed: geometry.framed });
      hint = this.filterEditing ? "" : this.log ? "↑↓ scroll · l log off · esc back" : this.level === "topics" ? "↑↓ topic · ⏎ open · / filter · l log · n new · ? keys · esc close" : this.level === "keys" ? "↑↓ key · ⏎ detail · o full · e edit · d delete · x expire · l log · esc back" : "↑↓ scroll · o full · e edit · d delete · x expire · esc back";
    }
    const status = this.filterEditing
      ? [{ text: `/ ${this.filter}▌`, color: "accent" as const }]
      : this.note ? statusLine(`⚠ ${this.note.text}`, contentWidth, this.note.color) : statusLine(hint, contentWidth);
    return paintPanelRows(styleWorkflowCardLines([...header, ...body, status].map(line => clampLine(line, contentWidth)), this.theme), width);
  }

  invalidate(): void {}

  dispose(): void { this.closed = true; this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  private close(): void { if (this.closed) return; this.dispose(); this.done(undefined); }
  private scrollRows(rows: WorkflowCardLine[], viewport: number): WorkflowCardLine[] {
    this.scrollMax = Math.max(0, rows.length - viewport);
    this.scroll = Math.max(0, Math.min(this.scroll, this.scrollMax));
    return rows.slice(this.scroll, this.scroll + viewport);
  }
  private allTopics(): TopicGroup[] { return groups(this.entries); }
  private visibleTopics(): TopicGroup[] {
    if (!this.filter) return this.allTopics();
    const query = this.filter.toLowerCase();
    return this.allTopics().filter(topic => topic.topic.toLowerCase().includes(query) || topic.entries.some(entry => entry.key.toLowerCase().includes(query)));
  }
  private topicEntries(topic: string | undefined): BlackboardEntry[] { return this.allTopics().find(group => group.topic === topic)?.entries ?? []; }
  private visibleKeys(topic: string | undefined): BlackboardEntry[] {
    const entries = this.topicEntries(topic);
    if (!this.filter || topic?.toLowerCase().includes(this.filter.toLowerCase())) return entries;
    return entries.filter(entry => entry.key.toLowerCase().includes(this.filter.toLowerCase()));
  }
  private selectedEntry(): BlackboardEntry | undefined { return this.topicEntries(this.selectedTopic).find(entry => entry.key === this.selectedKey); }
  private reconcileSelection(): void {
    const topics = this.visibleTopics();
    if (!topics.some(topic => topic.topic === this.selectedTopic)) this.selectedTopic = topics[0]?.topic;
    const keys = this.visibleKeys(this.selectedTopic);
    if (!keys.some(entry => entry.key === this.selectedKey)) this.selectedKey = keys[0]?.key;
  }
  private topicTitle(): string { return this.filter ? `Topics · ${this.visibleTopics().length}/${this.allTopics().length}` : "Topics"; }
  private keyTitle(): string {
    const all = this.topicEntries(this.selectedTopic);
    const visible = this.visibleKeys(this.selectedTopic);
    return this.filter ? `${this.selectedTopic ?? "Keys"} · ${visible.length}/${all.length}` : this.selectedTopic ?? "Keys";
  }
  private detailTitle(width: number): string { return truncateLeft(`${this.selectedTopic ?? ""}/${this.selectedKey ?? ""}`, Math.max(1, width - 4)); }
  private topicRows(width: number): WorkflowCardLine[] {
    return this.visibleTopics().map(topic => {
      const selected = topic.topic === this.selectedTopic;
      const focused = this.level === "topics" && !this.log;
      const count = String(topic.entries.length);
      const left = clampLine([
        { text: ` ${selected ? focused ? "❯" : "▸" : " "} `, color: selected && focused ? "accent" : "dim" },
        { text: singleLine(topic.topic), color: selected && focused ? "accent" : "muted", bold: selected && focused },
      ], Math.max(0, width - visibleWidth(count) - 1));
      const used = left.reduce((total, segment) => total + visibleWidth(segment.text), 0);
      return [...left, { text: " ".repeat(Math.max(1, width - used - visibleWidth(count))) }, { text: count, color: "dim" }];
    });
  }
  private keyRows(width: number): WorkflowCardLine[] {
    const now = Date.now();
    return this.visibleKeys(this.selectedTopic).map(entry => {
      const selected = entry.key === this.selectedKey;
      const focused = this.level === "keys" && !this.log;
      const marks = `${entry.author === "operator" ? "*" : " "}${entry.expiresAt !== null ? "~" : " "}`;
      const right = width >= 26 ? ` rev ${entry.revision} ${relative(entry.updatedAt, now)}` : width >= 19 ? ` rev ${entry.revision}` : "";
      return [{ text: ` ${selected ? focused ? "❯" : "▸" : " "} `, color: selected && focused ? "accent" : "dim" }, { text: `${marks} `, color: "accent" }, { text: singleLine(entry.key), color: selected && focused ? "accent" : "muted", bold: selected && focused }, { text: right, color: "dim" }];
    });
  }
  private logRows(_width: number): WorkflowCardLine[] {
    if (this.logError) return [[{ text: `⚠ Could not read the log: ${this.logError}`, color: "error" }]];
    if (this.logs.length === 0) return [[{ text: "  No write history yet.", color: "muted" }]];
    return this.logs.map(entry => [{ text: `${swissDate(entry.createdAt, entry.createdAt, false)}  `, color: "dim" }, { text: entry.op.padEnd(6), color: entry.op === "delete" ? "error" : entry.op === "expire" ? "warning" : "muted" }, { text: `  ${this.level === "topics" ? `${singleLine(entry.topic)}/` : ""}${singleLine(entry.key)}  ${singleLine(entry.author)}`, color: "muted" }]);
  }
  private schedule(): void {
    if (this.closed || this.busy || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, PANEL_REFRESH_MS);
    this.timer.unref?.();
  }
  private async refresh(): Promise<void> {
    if (this.closed || this.busy) return;
    const generation = this.generation;
    try {
      const entries = this.service.boardList();
      const info = this.service.getPanelInfo();
      if (this.closed || generation !== this.generation) return;
      this.applyEntries(entries);
      this.info = info;
      this.snapshotAt = Date.now();
      if (this.log) await this.refreshLog();
      this.tui.requestRender();
    } catch (error) {
      this.note = { text: `Refresh failed: ${messageOf(error)}. Showing the snapshot from ${swissDate(this.snapshotAt, Date.now(), false)}.`, color: "error" };
      this.tui.requestRender();
    } finally { this.schedule(); }
  }
  private applyEntries(entries: BlackboardEntry[]): void {
    const beforeTopics = this.allTopics();
    this.oldTopicIndex = Math.max(0, beforeTopics.findIndex(topic => topic.topic === this.selectedTopic));
    this.oldKeyIndex = Math.max(0, this.topicEntries(this.selectedTopic).findIndex(entry => entry.key === this.selectedKey));
    const topicGone = this.selectedTopic !== undefined && !entries.some(entry => entry.topic === this.selectedTopic);
    const keyGone = this.selectedKey !== undefined && !entries.some(entry => entry.topic === this.selectedTopic && entry.key === this.selectedKey);
    this.entries = entries;
    const after = this.allTopics();
    if (topicGone) {
      this.selectedTopic = after[Math.min(this.oldTopicIndex, Math.max(0, after.length - 1))]?.topic;
      this.selectedKey = this.topicEntries(this.selectedTopic)[0]?.key;
      this.level = "topics";
      this.note = { text: "The topic you had selected is gone.", color: "warning" };
    } else if (keyGone) {
      const keys = this.topicEntries(this.selectedTopic);
      this.selectedKey = keys[Math.min(this.oldKeyIndex, Math.max(0, keys.length - 1))]?.key;
      if (!this.suppressGoneNote) this.note = { text: "The entry you had selected is gone.", color: "warning" };
    }
    this.suppressGoneNote = false;
    this.reconcileSelection();
  }
  private async refreshLog(): Promise<void> {
    try {
      this.logs = this.service.boardRecentLog(this.level === "topics" ? { limit: 100 } : { topic: this.selectedTopic, limit: 100 });
      this.logError = undefined;
    } catch (error) { this.logError = messageOf(error); }
  }
  private async withDialog(work: () => Promise<void>): Promise<void> {
    this.busy = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.overlay()?.setHidden(true);
    try { await work(); }
    catch (error) { this.notify(`The board could not be written: ${messageOf(error)}`, "error"); }
    finally {
      this.busy = false;
      if (!this.closed) {
        this.overlay()?.setHidden(false);
        this.overlay()?.focus();
        await this.refresh();
        this.tui.requestRender();
      }
    }
  }
  private notify(text: string, type: "info" | "warning" | "error"): void {
    if (this.closed) return;
    this.ui.notify(text, type);
    // Host notifications live under overlays; keep the outcome readable on return.
    this.note = { text, color: type === "error" ? "error" : "warning" };
    this.tui.requestRender();
  }
  private async input(title: string, placeholder: string, prefill: string): Promise<string | undefined> {
    this.overlay()?.setHidden(false);
    try { return await showPrefillInput(this.ui, title, placeholder, prefill); }
    finally { if (!this.closed) { this.overlay()?.focus(); this.overlay()?.setHidden(true); } }
  }
  private async editValue(title: string, target: BlackboardDialogTarget, draft: string): Promise<string | undefined> {
    this.overlay()?.setHidden(false);
    try {
      const result = await showBlackboardValueEditor(this.ui, title, target, draft);
      if (this.closed) return undefined;
      if (result.kind === "quit") this.close();
      return result.kind === "submit" ? result.text : undefined;
    } finally { if (!this.closed) { this.overlay()?.focus(); this.overlay()?.setHidden(true); } }
  }
  private async acknowledge(topic: string, key: string, text: string, color: "warning" | "error" = "warning", chooseKey = false): Promise<boolean> {
    if (this.closed) return false;
    this.note = { text, color };
    const result = await showBlackboardAcknowledgement(this.ui, `${singleLine(topic)}/${singleLine(key)}`, color === "error" ? `${text}\n\nYour text is still here.` : text, chooseKey);
    if (this.closed) return false;
    if (result === "quit") this.close();
    else if (result !== "continue") this.level = "keys";
    return result === "continue";
  }
  private async createEntry(): Promise<void> {
    await this.withDialog(async () => {
      const prefix = this.info.operatorTopicPrefix;
      let topic = this.selectedTopic?.startsWith(prefix) ? this.selectedTopic : prefix;
      while (true) {
        const input = await this.input(`Topic (must start with ${prefix})`, `${prefix}constraints`, topic);
        if (this.closed || input === undefined) return;
        topic = input;
        if (topic?.startsWith(prefix)) break;
        if (!await this.acknowledge(topic, "", `Operator entries must be under "${prefix}".`)) return;
      }
      let key = "";
      let draft = "";
      while (true) {
        const keyInput = await this.input("Key", "no-direct-db-writes", key);
        if (this.closed || keyInput === undefined) return;
        key = keyInput;
        if (!key.trim()) {
          if (!await this.acknowledge(topic, key, "A key is required.")) return;
          continue;
        }
        key = key.trim();
        let chooseAnotherKey = false;
        while (!chooseAnotherKey) {
          const edited = await this.editValue(`Value for ${singleLine(topic)}/${singleLine(key)} — JSON is stored as JSON, anything else as text`, { topic, key, revision: null, author: "operator" }, draft);
          if (this.closed || edited === undefined) return;
          draft = edited;
          let result: OperatorPutResult;
          try { result = this.service.operatorPut({ topic, key, value: parseValue(draft), expectedToken: null }); }
          catch (error) {
            if (!await this.acknowledge(topic, key, `The board could not be written: ${messageOf(error)}`, "error")) return;
            continue;
          }
          if (result.ok) {
            this.selectedTopic = topic; this.selectedKey = key; this.level = "keys";
            this.notify(`Published ${singleLine(topic)}/${singleLine(key)}.`, "info"); return;
          }
          if (result.reason === "entry-changed") {
            this.selectedTopic = topic; this.selectedKey = key; this.level = "keys";
            if (!await this.acknowledge(topic, key, `${singleLine(topic)}/${singleLine(key)} already exists. Nothing was written and your text is kept — enter a different key, or press Esc and use e to edit the existing entry.`, "warning", true)) return;
            chooseAnotherKey = true;
            continue;
          }
          if (result.reason === "read-only-namespace") {
            this.notify(`Operator entries must be under "${prefix}".`, "warning");
            return;
          }
          if (result.reason === "not-operator-authored") {
            if (!await this.acknowledge(topic, key, `This entry was written by ${singleLine(result.current?.author ?? "unknown")}, not by you. Operator edits are limited to operator-authored entries.`, "warning", true)) return;
            chooseAnotherKey = true;
          } else if (result.reason === "not-found") {
            if (!await this.acknowledge(topic, key, `${singleLine(topic)}/${singleLine(key)} was deleted while you were editing. Nothing was written. Submit again to publish it as a new entry.`)) return;
          }
        }
      }
    });
  }
  private async editEntry(): Promise<void> {
    const initial = this.selectedEntry();
    if (!initial) return;
    const prefix = this.info.operatorTopicPrefix;
    if (!initial.topic.startsWith(prefix)) return this.notify(`Only entries under "${prefix}" can be edited here.`, "warning");
    if (initial.author !== "operator" || initial.authorAgentId !== null) return this.notify(`This entry was written by ${initial.author}, not by you. Operator edits are limited to operator-authored entries.`, "warning");
    if (initial.authorSessionId === null) return this.notify("This entry's writing session was not recorded, so it cannot be edited here.", "warning");
    if (initial.entryToken === null) return this.notify("This entry has no audit record, so it cannot be changed from here.", "warning");
    await this.withDialog(async () => {
      const target = `${singleLine(initial.topic)}/${singleLine(initial.key)}`;
      let draft = valueText(initial.value);
      let expectedToken: number | null = initial.entryToken;
      let revision: number | null = initial.revision;
      while (true) {
        const edited = await this.editValue(`Edit ${target} — JSON is stored as JSON, anything else as text`, { topic: initial.topic, key: initial.key, revision, author: initial.author }, draft);
        if (this.closed || edited === undefined) return;
        draft = edited;
        let result: OperatorPutResult;
        try { result = this.service.operatorPut({ topic: initial.topic, key: initial.key, value: parseValue(draft), expectedToken }); }
        catch (error) {
          if (!await this.acknowledge(initial.topic, initial.key, `The board could not be written: ${messageOf(error)}`, "error")) return;
          continue;
        }
        if (result.ok) { this.notify(`Updated ${target} to revision ${result.entry.revision}.`, "info"); return; }
        if (result.reason === "entry-changed") {
          expectedToken = result.current?.entryToken ?? null;
          revision = result.current?.revision ?? null;
          if (!await this.acknowledge(initial.topic, initial.key, `${target} changed while you were editing. Nothing was written. Your text is still here — submit again to apply it to revision ${result.current?.revision ?? "?"}.`)) return;
          continue;
        }
        if (result.reason === "not-found") {
          expectedToken = null;
          revision = null;
          if (!await this.acknowledge(initial.topic, initial.key, `${target} was deleted while you were editing. Nothing was written. Submit again to publish it as a new entry.`)) return;
          continue;
        }
        this.notify(result.reason === "read-only-namespace" ? `Only entries under "${prefix}" can be edited here.` : `This entry was written by ${initial.author}, not by you. Operator edits are limited to operator-authored entries.`, "warning");
        return;
      }
    });
  }
  private async removeEntry(op: "delete" | "expire"): Promise<void> {
    const entry = this.selectedEntry();
    if (!entry) return;
    if (entry.entryToken === null) return this.notify("This entry has no audit record, so it cannot be changed from here.", "warning");
    const token = entry.entryToken;
    const target = `${singleLine(entry.topic)}/${singleLine(entry.key)}`;
    const author = singleLine(entry.author);
    await this.withDialog(async () => {
      const verb = op === "delete" ? "Delete" : "Expire";
      const title = this.tui.terminal.rows <= 12
        ? `${verb}? ${target} · rev ${entry.revision}`
        : `${verb} entry? ${target} by ${author} · rev ${entry.revision} — ${op === "delete" ? "will be removed and the deletion recorded in the log" : "will be removed now and recorded in the log as an expiry"}. This cannot be undone.`;
      const choice = await this.ui.select(title, ["No, keep it", op === "delete" ? "Yes, delete it" : "Yes, expire it"]);
      if (this.closed) return;
      if (!choice?.startsWith("Yes")) { this.notify("Nothing was changed.", "info"); return; }
      let result: OperatorDeleteResult;
      try { result = op === "delete" ? this.service.operatorDelete({ topic: entry.topic, key: entry.key, expectedToken: token }) : this.service.operatorExpire({ topic: entry.topic, key: entry.key, expectedToken: token }); }
      catch (error) { this.notify(`The board could not be written: ${messageOf(error)}`, "error"); return; }
      if (result.ok) { this.suppressGoneNote = true; this.notify(`${op === "delete" ? "Deleted" : "Expired"} ${target}.`, "info"); return; }
      if (result.reason === "entry-changed") this.notify(`${target} changed since you selected it. Nothing was changed — the entry shown is the current one.`, "warning");
      else if (result.reason === "not-found") this.notify(`${target} is already gone. Nothing was changed.`, "warning");
    });
  }
}

export async function showBlackboardPanel(ui: BlackboardUI, service: BlackboardService): Promise<void> {
  let initial: BlackboardPanelInitial;
  try { initial = { entries: service.boardList(), info: service.getPanelInfo() }; }
  catch (error) { ui.notify(`Could not open the blackboard: ${messageOf(error)}`, "error"); return; }
  let overlay: OverlayHandle | undefined;
  await ui.custom<undefined>((tui, theme, _keys, done) => new BlackboardPanel(tui, theme, done, service, ui, initial, () => overlay), {
    overlay: true,
    onHandle: handle => { overlay = handle; },
    overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
  });
}
