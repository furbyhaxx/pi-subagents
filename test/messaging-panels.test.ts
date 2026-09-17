import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import * as transcriptTail from "../src/messaging/transcript-tail.js";
import type { BlackboardEntry } from "../src/messaging/types.js";
import * as boardDialogs from "../src/ui/blackboard-dialogs.js";
import { BlackboardPanel, type BlackboardPanelInitial, type MessagingPanelTui } from "../src/ui/blackboard-panel.js";
import { layoutMessagingCard, plainMessagingCardLines } from "../src/ui/messaging-card.js";
import { MessagingPrefillInput } from "../src/ui/messaging-panel-common.js";
import { type PanelPeer, PeersPanel, peerDisplayIdentities } from "../src/ui/peers-panel.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const info = {
  scopeKey: "project:test",
  scopeMode: "project" as const,
  databasePath: "/tmp/project-test/messaging.sqlite3",
  operatorTopicPrefix: "operator/",
  sessionId: "session-own",
  transport: "socket" as const,
};

function entry(over: Partial<BlackboardEntry> = {}): BlackboardEntry {
  return {
    topic: "operator/constraints",
    key: "policy",
    value: { deny: true },
    author: "operator",
    authorAgentId: null,
    authorSessionId: info.sessionId,
    entryToken: 7,
    revision: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    expiresAt: null,
    ...over,
  };
}

function peer(over: Partial<PanelPeer> = {}): PanelPeer {
  return {
    agentId: "agent-1",
    handle: "explore",
    type: "explorer",
    description: "Inspect source",
    sessionId: info.sessionId,
    kind: "sub",
    status: "running",
    pid: process.pid,
    createdAt: 1,
    seenAt: 1_700_000_000_000,
    unread: 2,
    access: "local",
    ...over,
  };
}

function tui(rows = 24): MessagingPanelTui & { renders: number } {
  return {
    terminal: { rows },
    renders: 0,
    requestRender() { this.renders++; },
  };
}

const wait = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };

function ui(over: Record<string, unknown> = {}) {
  return {
    custom: vi.fn(),
    input: vi.fn(async () => undefined as string | undefined),
    editor: vi.fn(async () => undefined as string | undefined),
    select: vi.fn(async () => undefined as string | undefined),
    notify: vi.fn(),
    ...over,
  };
}

function boardService(initialEntries: BlackboardEntry[]) {
  let entries = initialEntries;
  return {
    setEntries(next: BlackboardEntry[]) { entries = next; },
    boardList: vi.fn(() => entries),
    boardRecentLog: vi.fn(() => []),
    getPanelInfo: vi.fn(() => info),
    operatorPut: vi.fn(() => ({ ok: true as const, entry: entry() })),
    operatorDelete: vi.fn(() => ({ ok: true as const, op: "delete" as const, entry: entry() })),
    operatorExpire: vi.fn(() => ({ ok: true as const, op: "expire" as const, entry: entry() })),
  };
}

function peerService(initialPeers: PanelPeer[]) {
  let peers = initialPeers;
  return {
    setPeers(next: PanelPeer[]) { peers = next; },
    panelPeers: vi.fn(() => peers),
    getPanelInfo: vi.fn(() => info),
  };
}

let hermetic: Hermetic | undefined;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  hermetic?.restore();
  hermetic = undefined;
});

describe("/agents messaging panel wiring", () => {
  it("adds both entries only after the messaging store opens", async () => {
    hermetic = hermeticDir();
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
        addAutocompleteProvider: vi.fn(),
        onTerminalInput: vi.fn(() => vi.fn()),
        getEditorText: vi.fn(() => ""),
        select: vi.fn(async () => undefined),
      },
    });
    await booted.lifecycle.get("session_start")?.({}, context);
    await booted.commands.get("agents").handler("", context);
    const options = context.ui.select.mock.calls[0]?.[1] as string[];
    expect(options).toContain("Blackboard (0 topics)");
    expect(options).toContain("Peers (1)");
    await booted.lifecycle.get("session_shutdown")?.({}, context);
  });
});

describe("Blackboard panel", () => {
  it("drills through one pane at 40 columns and keeps every line bounded", () => {
    const initial: BlackboardPanelInitial = { entries: [entry()], info };
    const panel = new BlackboardPanel(tui(12), theme, vi.fn(), boardService(initial.entries), ui(), initial);
    const topics = panel.render(40);
    expect(topics.some(line => line.includes("Topics"))).toBe(true);
    expect(topics.every(line => visibleWidth(line) <= 40)).toBe(true);
    expect(topics.filter(line => line.includes("╭")).length).toBe(1);

    panel.handleInput("\r");
    expect(panel.render(40).some(line => line.includes("operator/constraints"))).toBe(true);
    panel.handleInput("\r");
    expect(panel.render(40).some(line => line.includes("revision"))).toBe(true);
    panel.handleInput("\u001b");
    expect(panel.render(40).some(line => line.includes("policy"))).toBe(true);
    panel.dispose();
  });

  it("fails closed on cancel and reports a stale captured delete token", async () => {
    const selected = entry();
    const service = boardService([selected]);
    const dialogs = ui({ select: vi.fn(async () => "No, keep it") });
    const panel = new BlackboardPanel(tui(), theme, vi.fn(), service, dialogs, { entries: [selected], info });
    panel.handleInput("\r");
    panel.handleInput("d");
    await wait();
    expect(service.operatorDelete).not.toHaveBeenCalled();
    expect(dialogs.notify).toHaveBeenCalledWith("Nothing was changed.", "info");

    dialogs.select.mockResolvedValueOnce("Yes, delete it");
    service.operatorDelete.mockReturnValueOnce({ ok: false, reason: "entry-changed", current: entry({ entryToken: 9 }) });
    panel.handleInput("d");
    await wait();
    expect(service.operatorDelete).toHaveBeenCalledWith({ topic: selected.topic, key: selected.key, expectedToken: 7 });
    expect(dialogs.notify).toHaveBeenCalledWith(expect.stringContaining("changed since you selected it"), "warning");
    panel.dispose();
  });

  it("retains an occupied create draft and every resubmit remains create-only", async () => {
    const service = boardService([entry()]);
    service.operatorPut
      .mockReturnValueOnce({ ok: false, reason: "entry-changed", current: entry() })
      .mockReturnValueOnce({ ok: true, entry: entry({ key: "other", entryToken: 9, revision: 1 }) });
    const dialogs = ui({
      custom: vi.fn()
        .mockResolvedValueOnce("operator/constraints")
        .mockResolvedValueOnce("policy")
        .mockResolvedValueOnce("other"),
    });
    const editor = vi.spyOn(boardDialogs, "showBlackboardValueEditor").mockResolvedValue({ kind: "submit", text: '{"a":1}' });
    const acknowledgement = vi.spyOn(boardDialogs, "showBlackboardAcknowledgement").mockResolvedValue("continue");
    const panel = new BlackboardPanel(tui(), theme, vi.fn(), service, dialogs, { entries: [entry()], info });
    panel.handleInput("n");
    await wait();
    expect(service.operatorPut).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: "policy", expectedToken: null, value: { a: 1 } }));
    expect(service.operatorPut).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: "other", expectedToken: null, value: { a: 1 } }));
    expect(editor).toHaveBeenNthCalledWith(2, dialogs, expect.stringContaining("operator/constraints/other"), expect.objectContaining({ key: "other", revision: null }), '{"a":1}');
    expect(acknowledgement).toHaveBeenCalledWith(dialogs, "operator/constraints/policy", expect.stringContaining("already exists"), true);
    expect(dialogs.notify).not.toHaveBeenCalledWith(expect.stringContaining("already exists"), "warning");
    panel.dispose();
  });

  it("reopens the value editor, not the key input, after a thrown create write", async () => {
    const service = boardService([]);
    service.operatorPut
      .mockImplementationOnce(() => { throw new Error("database busy"); })
      .mockReturnValueOnce({ ok: true, entry: entry({ key: "new", revision: 1 }) });
    const dialogs = ui({
      custom: vi.fn().mockResolvedValueOnce("operator/constraints").mockResolvedValueOnce("new"),
    });
    const editor = vi.spyOn(boardDialogs, "showBlackboardValueEditor").mockResolvedValue({ kind: "submit", text: "kept draft" });
    const acknowledgement = vi.spyOn(boardDialogs, "showBlackboardAcknowledgement").mockResolvedValue("continue");
    const panel = new BlackboardPanel(tui(), theme, vi.fn(), service, dialogs, { entries: [], info });
    panel.handleInput("n");
    await wait();
    expect(dialogs.custom).toHaveBeenCalledTimes(2);
    expect(editor).toHaveBeenNthCalledWith(2, dialogs, expect.any(String), expect.objectContaining({ key: "new" }), "kept draft");
    expect(service.operatorPut).toHaveBeenCalledTimes(2);
    expect(acknowledgement).toHaveBeenCalledWith(dialogs, "operator/constraints/new", "The board could not be written: database busy\n\nYour text is still here.", false);
    expect(dialogs.notify).not.toHaveBeenCalledWith(expect.stringContaining("database busy"), "error");
    panel.dispose();
  });

  it("reopens an edit conflict with the draft and uses only the refreshed token", async () => {
    const selected = entry();
    const service = boardService([selected]);
    service.operatorPut
      .mockReturnValueOnce({ ok: false, reason: "entry-changed", current: entry({ entryToken: 9, revision: 4 }) })
      .mockReturnValueOnce({ ok: true, entry: entry({ entryToken: 10, revision: 5 }) });
    const dialogs = ui();
    const editor = vi.spyOn(boardDialogs, "showBlackboardValueEditor").mockResolvedValue({ kind: "submit", text: "draft text" });
    const acknowledgement = vi.spyOn(boardDialogs, "showBlackboardAcknowledgement").mockResolvedValue("continue");
    const panel = new BlackboardPanel(tui(), theme, vi.fn(), service, dialogs, { entries: [selected], info });
    panel.handleInput("\r");
    panel.handleInput("e");
    await wait();
    expect(service.operatorPut).toHaveBeenNthCalledWith(1, expect.objectContaining({ expectedToken: 7, value: "draft text" }));
    expect(service.operatorPut).toHaveBeenNthCalledWith(2, expect.objectContaining({ expectedToken: 9, value: "draft text" }));
    expect(editor).toHaveBeenNthCalledWith(2, dialogs, expect.any(String), expect.objectContaining({ revision: 4 }), "draft text");
    expect(acknowledgement).toHaveBeenCalledWith(dialogs, "operator/constraints/policy", expect.stringContaining("changed while you were editing"), false);
    expect(dialogs.notify).not.toHaveBeenCalledWith(expect.stringContaining("changed while you were editing"), "warning");
    panel.dispose();
  });

  it("refuses in-place editing for agent authors and unknown historical sessions", async () => {
    const agentEntry = entry({ author: "explore", authorAgentId: "agent-1" });
    const dialogs = ui();
    const panel = new BlackboardPanel(tui(), theme, vi.fn(), boardService([agentEntry]), dialogs, { entries: [agentEntry], info });
    panel.handleInput("\r");
    panel.handleInput("e");
    expect(dialogs.custom).not.toHaveBeenCalled();
    expect(dialogs.notify).toHaveBeenCalledWith(expect.stringContaining("written by explore"), "warning");
    panel.dispose();

    const historical = entry({ authorSessionId: null });
    const historicalUi = ui();
    const historicalPanel = new BlackboardPanel(tui(), theme, vi.fn(), boardService([historical]), historicalUi, { entries: [historical], info });
    historicalPanel.handleInput("\r");
    expect(historicalPanel.render(80).join("\n")).toContain("session unknown");
    expect(historicalPanel.render(80).join("\n")).toContain("Writing session was not recorded.");
    historicalPanel.handleInput("e");
    expect(historicalUi.custom).not.toHaveBeenCalled();
    expect(historicalUi.notify).toHaveBeenCalledWith(expect.stringContaining("writing session was not recorded"), "warning");
    historicalPanel.dispose();
  });

  it("retains selection identity when refresh reorders keys", async () => {
    const old = entry({ key: "old", updatedAt: 10 });
    const selected = entry({ key: "selected", updatedAt: 5 });
    const service = boardService([old, selected]);
    const panel = new BlackboardPanel(tui(), theme, vi.fn(), service, ui(), { entries: [old, selected], info });
    panel.handleInput("\r");
    panel.handleInput("j");
    expect(panel.render(80).join("\n")).toContain("❯ *  selected");
    service.setEntries([entry({ key: "selected", updatedAt: 20 }), entry({ key: "old", updatedAt: 1 })]);
    panel.handleInput("r");
    await wait();
    expect(panel.render(80).join("\n")).toContain("❯ *  selected");
    panel.dispose();
  });
});

describe("Peers panel", () => {
  it("disambiguates colliding aliases and renders scope plus transport at narrow width", () => {
    const peers = [
      peer({ agentId: "a", alias: "audit", sessionId: "abcdef111" }),
      peer({ agentId: "b", alias: "audit", sessionId: "abcdef222", access: "read-only" }),
    ];
    expect(peerDisplayIdentities(peers)).toEqual(new Map([["a", "audit@abcdef1"], ["b", "audit@abcdef2"]]));
    const panel = new PeersPanel(tui(12), theme, vi.fn(), peerService(peers), ui(), { openLocal: vi.fn() }, { peers, info });
    const lines = panel.render(40);
    expect(lines.join("\n")).toContain("scope project");
    expect(lines.join("\n")).toContain("live");
    expect(lines.join("\n")).toContain("2 unread");
    expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true);
    panel.dispose();
  });

  it("rechecks main and local access on Enter and never opens a viewer for a gone record", async () => {
    const main = peer({ agentId: "main:session-own", kind: "main", access: "main" });
    const local = peer({ agentId: "local", handle: "local", access: "local" });
    const service = peerService([main, local]);
    const done = vi.fn();
    const openLocal = vi.fn(async () => "missing" as const);
    const dialogs = ui();
    const panel = new PeersPanel(tui(), theme, done, service, dialogs, { openLocal }, { peers: [main, local], info });
    panel.handleInput("j");
    panel.handleInput("\r");
    await wait();
    expect(openLocal).toHaveBeenCalledWith("local");
    expect(dialogs.notify).toHaveBeenCalledWith("That agent is no longer running in this session.", "warning");

    panel.handleInput("g");
    panel.handleInput("\r");
    await wait();
    expect(done).toHaveBeenCalledWith("main");
  });

  it("opens a hermetic foreign file as a bounded read-only tail and cleans up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "messaging-panel-"));
    try {
      const path = join(dir, "foreign.jsonl");
      await writeFile(path, '{"type":"message","text":"hello"}\n', "utf8");
      const foreign = peer({ agentId: "foreign", sessionId: "foreign-session", access: "read-only", sessionFile: path });
      const openLocal = vi.fn();
      const done = vi.fn();
      const panel = new PeersPanel(tui(), theme, done, peerService([foreign]), ui(), { openLocal }, { peers: [foreign], info });
      panel.handleInput("\r");
      await vi.waitFor(() => expect(panel.render(80).join("\n")).toContain("File tail"));
      const rendered = panel.render(80).join("\n");
      expect(rendered).toContain("File tail");
      expect(rendered).toContain("Raw file order, newest records last");
      expect(rendered).toContain("hello");
      expect(panel.render(40).join("\n")).toContain("File tail");
      expect(rendered).not.toContain("steer");
      expect(openLocal).not.toHaveBeenCalled();
      panel.handleInput("q");
      expect(done).toHaveBeenCalledWith(undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("panel cleanup", () => {
  it("clears self-scheduled refreshes when either panel closes", () => {
    vi.useFakeTimers();
    const blackboardDone = vi.fn();
    const blackboard = new BlackboardPanel(tui(), theme, blackboardDone, boardService([entry()]), ui(), { entries: [entry()], info });
    const peersDone = vi.fn();
    const peers = new PeersPanel(tui(), theme, peersDone, peerService([peer()]), ui(), { openLocal: vi.fn() }, { peers: [peer()], info });
    expect(vi.getTimerCount()).toBe(2);
    blackboard.handleInput("q");
    peers.handleInput("q");
    expect(blackboardDone).toHaveBeenCalledOnce();
    expect(peersDone).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("messaging card expiry", () => {
  it("labels explicit expiry before revision fallbacks", () => {
    const lines = plainMessagingCardLines(layoutMessagingCard({
      kind: "board",
      op: "expire",
      topic: "operator/constraints",
      key: "policy",
      author: "operator",
      revision: 3,
      at: 1,
    }));
    expect(lines[0]).toBe("▤ blackboard  operator/constraints/policy  · operator · expired");
  });
});


describe("review regressions", () => {
  it("does not write after a disposed confirmation resolves", async () => {
    let finish: ((value: string) => void) | undefined;
    const service = boardService([entry()]);
    const dialogs = ui({ select: vi.fn(() => new Promise<string>(resolve => { finish = resolve; })) });
    const overlay = { setHidden: vi.fn(), focus: vi.fn() };
    const panel = new BlackboardPanel(tui(12), theme, vi.fn(), service, dialogs, { entries: [entry()], info }, () => overlay);
    panel.handleInput("\r"); panel.handleInput("d");
    expect(dialogs.select).toHaveBeenCalledWith("Delete? operator/constraints/policy · rev 3", ["No, keep it", "Yes, delete it"]);
    panel.dispose();
    finish?.("Yes, delete it"); await wait();
    expect(service.operatorDelete).not.toHaveBeenCalled();
    expect(overlay.focus).not.toHaveBeenCalled();
    expect(dialogs.notify).not.toHaveBeenCalled();
  });

  it("discards a local viewer result after panel disposal", async () => {
    let finish: ((result: "no-session") => void) | undefined;
    const openLocal = vi.fn(() => new Promise<"no-session">(resolve => { finish = resolve; }));
    const terminal = tui();
    const service = peerService([peer()]);
    const dialogs = ui();
    const panel = new PeersPanel(terminal, theme, vi.fn(), service, dialogs, { openLocal }, { peers: [peer()], info });
    panel.handleInput("\r");
    panel.dispose();
    const renders = terminal.renders;
    const reads = service.panelPeers.mock.calls.length;
    finish?.("no-session");
    await wait();
    expect(terminal.renders).toBe(renders);
    expect(service.panelPeers).toHaveBeenCalledTimes(reads);
    expect(dialogs.notify).not.toHaveBeenCalled();
    expect(panel.render(72).join("\n")).not.toContain("reason");
  });
  it.each(["topics", "help", "value"])("does not dispatch entry actions from %s", async location => {
    const service = boardService([entry()]);
    const dialogs = ui();
    const panel = new BlackboardPanel(tui(), theme, vi.fn(), service, dialogs, { entries: [entry()], info });
    if (location === "help") panel.handleInput("?");
    if (location === "value") { panel.handleInput("\r"); panel.handleInput("o"); }
    const before = panel.render(72);
    for (const key of ["d", "e", "x", "o"]) panel.handleInput(key);
    await wait();
    expect(dialogs.select).not.toHaveBeenCalled();
    expect(dialogs.custom).not.toHaveBeenCalled();
    expect(service.operatorDelete).not.toHaveBeenCalled();
    expect(service.operatorExpire).not.toHaveBeenCalled();
    expect(panel.render(72)).toEqual(before);
    panel.dispose();
  });

  it("clamps detail and log End, repeated down, refresh shrink and resize", async () => {
    const selected = entry({ value: Array.from({ length: 60 }, (_, i) => `VALUE-${i}`).join("\n") });
    const service = boardService([selected]);
    const logs = Array.from({ length: 60 }, (_, i) => ({ ...selected, key: `LOG-${i}`, seq: i, op: "put" as const }));
    service.boardRecentLog.mockReturnValue(logs);
    const terminal = tui(12);
    const panel = new BlackboardPanel(terminal, theme, vi.fn(), service, ui(), { entries: [selected], info });
    panel.render(36); panel.handleInput("\r"); panel.handleInput("\r");
    panel.handleInput("\u001b[F");
    expect(panel.render(36).join("\n")).toContain("VALUE-59");
    for (let i = 0; i < 100; i++) panel.handleInput("j");
    expect(panel.render(36).join("\n")).toContain("VALUE-59");
    panel.handleInput("g");
    expect(panel.render(36).join("\n")).toContain("author");
    panel.handleInput("G");
    service.setEntries([entry({ value: "SHRUNK" })]);
    panel.handleInput("r"); await wait();
    expect(panel.render(36).join("\n")).toContain("SHRUNK");
    panel.handleInput("l"); await wait(); panel.handleInput("G");
    expect(panel.render(36).join("\n")).toContain("LOG-59");
    terminal.terminal = { rows: 30 };
    expect(panel.render(108).join("\n")).toContain("LOG-59");
    panel.handleInput("g");
    expect(panel.render(108).join("\n")).toContain("LOG-0");
    panel.dispose();
  });

  it("distinguishes active and preview selection in monochrome", () => {
    const panel = new BlackboardPanel(tui(), theme, vi.fn(), boardService([entry()]), ui(), { entries: [entry()], info });
    const topics = stripTerminalSequences(panel.render(72).join("\n"));
    expect(topics).toContain("❯ Topics");
    expect(topics).toContain("▸ *  policy");
    panel.handleInput("\r"); panel.handleInput("\r");
    expect(stripTerminalSequences(panel.render(72).join("\n"))).toContain("▸ *  policy");
    panel.dispose();
  });

  it.each([false, true])("hides host dialogs and restores focus in finally (throw=%s)", async throws => {
    vi.useFakeTimers();
    const service = boardService([entry()]);
    let resolve: ((value: string | undefined) => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    const select = vi.fn(() => new Promise<string | undefined>((yes, no) => { resolve = yes; reject = no; }));
    const overlay = { setHidden: vi.fn(), focus: vi.fn() };
    const panel = new BlackboardPanel(tui(), theme, vi.fn(), service, ui({ select }), { entries: [entry()], info }, () => overlay);
    panel.handleInput("\r"); panel.handleInput("d");
    expect(overlay.setHidden).toHaveBeenLastCalledWith(true);
    expect(select.mock.calls[0]?.[0]).toContain("rev 3");
    expect(select.mock.calls[0]?.[1]).toEqual(["No, keep it", "Yes, delete it"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(service.boardList).not.toHaveBeenCalled();
    if (throws) reject?.(new Error("dialog failed")); else resolve?.("No, keep it");
    await vi.advanceTimersByTimeAsync(0);
    expect(overlay.setHidden).toHaveBeenLastCalledWith(false);
    expect(overlay.focus).toHaveBeenCalledOnce();
    expect(service.boardList).toHaveBeenCalledOnce();
    expect(panel.render(108).join("\n")).toContain(throws ? "dialog failed" : "Nothing was changed");
    panel.dispose();
  });

  it.each(["read-only-namespace", "not-operator-authored", "not-found"] as const)("reports create refusal %s truthfully and keeps retries manual", async reason => {
    const service = boardService([]);
    service.operatorPut.mockReturnValue({ ok: false, reason, current: entry({ author: "agent-writer" }) });
    const dialogs = ui({ custom: vi.fn().mockResolvedValueOnce("operator/test").mockResolvedValueOnce("key") });
    const editor = vi.spyOn(boardDialogs, "showBlackboardValueEditor").mockResolvedValueOnce({ kind: "submit", text: "DRAFT" }).mockResolvedValue({ kind: "cancel" });
    const acknowledgement = vi.spyOn(boardDialogs, "showBlackboardAcknowledgement").mockResolvedValue("continue");
    const panel = new BlackboardPanel(tui(), theme, vi.fn(), service, dialogs, { entries: [], info });
    panel.handleInput("n"); await wait();
    const text = reason === "read-only-namespace" ? "must be under" : reason === "not-operator-authored" ? "written by agent-writer" : "was deleted";
    if (reason === "read-only-namespace") expect(dialogs.notify).toHaveBeenCalledWith(expect.stringContaining(text), "warning");
    else expect(acknowledgement).toHaveBeenCalledWith(dialogs, "operator/test/key", expect.stringContaining(text), reason === "not-operator-authored");
    expect(service.operatorPut).toHaveBeenCalledOnce();
    if (reason === "not-found") expect(editor).toHaveBeenNthCalledWith(2, dialogs, expect.any(String), expect.objectContaining({ revision: null }), "DRAFT");
    panel.dispose();
  });

  it("native input submits the editable prefill with caret at end and preserves host editing", () => {
    const done = vi.fn();
    const input = new MessagingPrefillInput("Topic", "placeholder", "operator/", theme, () => 24, done);
    input.focused = true;
    expect(input.render(36)).toHaveLength(9);
    expect(input.render(36).every(row => visibleWidth(row) === 36)).toBe(true);
    input.handleInput("qjkr/dexoln?"); input.handleInput("\r");
    expect(done).toHaveBeenLastCalledWith("operator/qjkr/dexoln?");
    const unchanged = new MessagingPrefillInput("Key", "placeholder", "occupied", theme, () => 10, done);
    expect(unchanged.render(36)).toHaveLength(5);
    unchanged.handleInput("\r");
    expect(done).toHaveBeenLastCalledWith("occupied");
    unchanged.handleInput("\u001f"); // native ctrl+- undo of the bracketed-paste prefill
    unchanged.handleInput("\r");
    expect(done).toHaveBeenLastCalledWith("");
    expect(stripTerminalSequences(unchanged.render(36).join("\n"))).toContain("placeholder");
    unchanged.handleInput("\u001b");
    expect(done).toHaveBeenLastCalledWith(undefined);
    const editing = new MessagingPrefillInput("Key", "", "abc", theme, () => 24, done);
    editing.handleInput("\u0001"); editing.handleInput("Z"); editing.handleInput("\u0005"); editing.handleInput("\u007f"); editing.handleInput("\r");
    expect(done).toHaveBeenLastCalledWith("Zab");
  });

  it.each([[36, 12], [72, 24]])("tail End/follow uses actual viewport at %sx%s and refresh never loads again", async (width, rows) => {
    const dir = await mkdtemp(join(tmpdir(), "tail-review-"));
    const path = join(dir, "tail.jsonl");
    const records = Array.from({ length: 45 }, (_, i) => JSON.stringify({ record: `RECORD-${String(i).padStart(3, "0")}` }));
    try {
      await writeFile(path, records.join("\n") + "\n");
      const foreign = peer({ access: "read-only", sessionId: "foreign", sessionFile: path });
      const terminal = tui(rows);
      const rendered: string[] = [];
      const panel = new PeersPanel(terminal, theme, vi.fn(), peerService([foreign]), ui(), { openLocal: vi.fn() }, { peers: [foreign], info });
      terminal.requestRender = () => { rendered.push(panel.render(width).join("\n")); };
      panel.render(width); panel.handleInput("\r");
      await vi.waitFor(() => expect(panel.render(width).join("\n")).toContain("RECORD-044"));
      panel.handleInput("g");
      expect(panel.render(width).join("\n")).toContain("RECORD-000");
      panel.handleInput("G");
      const bottom = panel.render(width);
      expect(bottom.join("\n")).toContain("RECORD-044");
      expect(bottom.join("\n")).toContain("45/45");
      expect(bottom.length).toBeLessThanOrEqual(Math.floor(rows * 0.7));
      expect(bottom.every(row => row.startsWith("\u001b[0m") && visibleWidth(row) === width)).toBe(true);
      rendered.length = 0;
      await writeFile(path, [...records, JSON.stringify({ record: "APPENDED-BOTTOM" })].join("\n") + "\n");
      await vi.waitFor(() => expect(panel.render(width).join("\n")).toContain("APPENDED-BOTTOM"), { timeout: 2500 });
      expect(rendered.every(frame => !frame.includes("Reading the session file"))).toBe(true);
      expect(panel.render(width).join("\n")).toContain("46/46");
      panel.handleInput("g");
      await writeFile(path, [...records, JSON.stringify({ record: "NEXT-BOTTOM" })].join("\n") + "\n");
      panel.handleInput("r");
      await vi.waitFor(() => expect(rendered.at(-1)).toContain("RECORD-000"));
      expect(panel.render(width).join("\n")).not.toContain("NEXT-BOTTOM");
      panel.dispose();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("list viewport regressions", () => {
  it.each(["topics", "keys"] as const)("keeps overflowing %s selection visible through navigation, filtering, refresh and resize", async level => {
    const entries = Array.from({ length: 30 }, (_, index) => entry({
      topic: level === "topics" ? `topic-${String(index).padStart(2, "0")}` : "operator/keys",
      key: `key-${String(index).padStart(2, "0")}`,
      updatedAt: 100 - index,
      entryToken: index + 1,
    }));
    const service = boardService(entries);
    const dialogs = ui({ select: vi.fn(async () => "Yes, delete it") });
    const terminal = tui(12);
    const panel = new BlackboardPanel(terminal, theme, vi.fn(), service, dialogs, { entries, info });
    if (level === "keys") panel.handleInput("\r");
    const selected = (index: number, width = 36) => {
      const label = `${level === "topics" ? "topic" : "key"}-${String(index).padStart(2, "0")}`;
      expect(stripTerminalSequences(panel.render(width).join("\n"))).toMatch(new RegExp(`❯ (?:\\*  )?${label}`));
    };
    selected(0);
    panel.handleInput("\u001b[F"); selected(29);
    panel.handleInput("\r");
    expect(panel.render(36).join("\n")).toContain(level === "topics" ? "key-29" : "operator/keys/key-29");
    panel.handleInput("\u001b"); selected(29);
    panel.handleInput("\u001b[5~"); selected(27);
    panel.handleInput("\u001b[6~"); selected(29);
    panel.handleInput("\u001b[H"); selected(0);
    panel.handleInput("\u001b[6~"); selected(2);
    panel.handleInput("G"); selected(29);
    terminal.terminal = { rows: 30 }; selected(29, 108);
    terminal.terminal = { rows: 12 }; selected(29);
    panel.handleInput("/"); for (const key of "29") panel.handleInput(key);
    selected(29); panel.handleInput("\r"); panel.handleInput("\u001b"); selected(29);
    panel.handleInput("/"); for (const key of "00") panel.handleInput(key);
    selected(0); panel.handleInput("\u001b"); selected(0);
    panel.handleInput("G"); selected(29);
    service.setEntries(entries.map(row => row.key === "key-29" ? { ...row, updatedAt: 200 } : row));
    panel.handleInput("r"); await wait(); selected(29);
    // Enter and a mutation still target the selected identity, not its old index.
    if (level === "topics") panel.handleInput("\r");
    panel.handleInput("d"); await wait();
    expect(service.operatorDelete).toHaveBeenLastCalledWith({ topic: entries[29]?.topic, key: "key-29", expectedToken: 30 });
    if (level === "topics") panel.handleInput("\u001b");
    service.setEntries(entries.filter(row => row.key !== "key-29"));
    panel.handleInput("r"); await wait(); selected(0);
    service.setEntries([]); panel.handleInput("r"); await wait();
    expect(panel.render(36).join("\n")).toContain("The board is empty");
    panel.dispose();
  });

  it("keeps overflowing peers visible without changing the Enter target", async () => {
    const peers = Array.from({ length: 30 }, (_, index) => peer({ agentId: `id-${index}`, alias: `peer-${String(index).padStart(2, "0")}` }));
    const service = peerService(peers);
    const terminal = tui(12);
    const openLocal = vi.fn(async () => "opened" as const);
    const panel = new PeersPanel(terminal, theme, vi.fn(), service, ui(), { openLocal }, { peers, info });
    const selected = (name: string, width = 36) => expect(stripTerminalSequences(panel.render(width).join("\n"))).toContain(`❯ ● ${name}`);
    selected("peer-00"); panel.handleInput("\u001b[F"); selected("peer-29");
    panel.handleInput("\r"); await wait(); expect(openLocal).toHaveBeenLastCalledWith("id-29"); selected("peer-29");
    panel.handleInput("\u001b[5~"); selected("peer-27"); panel.handleInput("\u001b[6~"); selected("peer-29");
    panel.handleInput("\u001b[H"); selected("peer-00"); panel.handleInput("\u001b[6~"); selected("peer-02");
    panel.handleInput("G"); selected("peer-29");
    terminal.terminal = { rows: 30 }; selected("peer-29", 108);
    terminal.terminal = { rows: 12 }; selected("peer-29");
    panel.handleInput("/"); for (const key of "29") panel.handleInput(key);
    selected("peer-29"); panel.handleInput("\r"); panel.handleInput("\u001b"); selected("peer-29");
    panel.handleInput("/"); for (const key of "00") panel.handleInput(key);
    selected("peer-00"); panel.handleInput("\u001b"); selected("peer-00");
    panel.handleInput("G");
    service.setPeers(peers.map(row => row.agentId === "id-29" ? { ...row, alias: "aaa-moved" } : row));
    panel.handleInput("r"); await wait(); selected("aaa-moved");
    panel.handleInput("\r"); await wait(); expect(openLocal).toHaveBeenLastCalledWith("id-29");
    service.setPeers(peers.filter(row => row.agentId !== "id-29")); panel.handleInput("r"); await wait(); selected("peer-00");
    panel.dispose();
  });
});

describe("Peers help refresh ownership", () => {
  it.each(["\u001b", "?"])("suspends roster refresh and resumes immediately and repeatedly on %s", async exit => {
    vi.useFakeTimers();
    const service = peerService([peer()]);
    const panel = new PeersPanel(tui(12), theme, vi.fn(), service, ui(), { openLocal: vi.fn() }, { peers: [peer()], info });
    panel.render(36); panel.handleInput("?"); panel.handleInput("G");
    const help = panel.render(36);
    expect(vi.getTimerCount()).toBe(0);
    service.setPeers([peer({ alias: "AFTER-HELP" })]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(service.panelPeers).not.toHaveBeenCalled(); expect(panel.render(36)).toEqual(help);
    panel.handleInput(exit);
    expect(service.panelPeers).toHaveBeenCalledOnce();
    expect(panel.render(36).join("\n")).toContain("❯ ● AFTER-HELP");
    service.setPeers([peer({ alias: "NEXT-TICK" })]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel.render(36).join("\n")).toContain("❯ ● NEXT-TICK");
    panel.handleInput("?"); panel.handleInput("q");
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.panelPeers).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["\u001b", "?"])("holds tail help against scheduled reads and restores scroll/follow on %s", async exit => {
    vi.useFakeTimers();
    const result = { ok: true as const, lines: Array.from({ length: 30 }, (_, i) => `LINE-${i}`), truncated: false, skippedLines: 0 };
    const read = vi.spyOn(transcriptTail, "readForeignTranscriptTail").mockResolvedValue(result);
    const foreign = peer({ access: "read-only", sessionFile: "/fixture/tail.jsonl" });
    const service = peerService([foreign]);
    const panel = new PeersPanel(tui(12), theme, vi.fn(), service, ui(), { openLocal: vi.fn() }, { peers: [foreign], info });
    panel.render(36); panel.handleInput("\r"); await vi.advanceTimersByTimeAsync(0);
    panel.handleInput("g"); panel.handleInput("j"); const before = panel.render(36);
    panel.handleInput("?"); panel.handleInput("G"); const help = panel.render(36);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2100);
    expect(read).toHaveBeenCalledOnce(); expect(panel.render(36)).toEqual(help);
    panel.handleInput(exit); await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2); expect(panel.render(36)).toEqual(before);
    read.mockResolvedValue({ ...result, lines: [...result.lines, "APPENDED"] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(3); expect(panel.render(36).join("\n")).toContain("LINE-1");
    panel.handleInput("G"); panel.handleInput("?"); panel.handleInput("g"); panel.handleInput(exit);
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.render(36).join("\n")).toContain("APPENDED");
    panel.handleInput("?"); panel.dispose(); await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["help", false], ["return", false], ["quit", false], ["dispose", false],
    ["help", true], ["return", true], ["quit", true], ["dispose", true],
  ] as const)("discards in-flight tail completion after help enter (%s, refresh=%s)", async (outcome, refreshing) => {
    vi.useFakeTimers();
    const result = { ok: true as const, lines: ["FRESH"], truncated: false, skippedLines: 0 };
    let resolve: ((result: transcriptTail.ForeignTranscriptTailResult) => void) | undefined;
    const read = vi.spyOn(transcriptTail, "readForeignTranscriptTail").mockResolvedValue(result);
    if (refreshing) read.mockResolvedValueOnce(result);
    read.mockImplementationOnce(() => new Promise(resolveRead => { resolve = resolveRead; }));
    const foreign = peer({ access: "read-only", sessionFile: "/fixture/tail.jsonl" });
    const terminal = tui(12);
    const panel = new PeersPanel(terminal, theme, vi.fn(), peerService([foreign]), ui(), { openLocal: vi.fn() }, { peers: [foreign], info });
    panel.render(36); panel.handleInput("\r");
    if (refreshing) await vi.advanceTimersByTimeAsync(1000);
    const initialReads = refreshing ? 2 : 1;
    const signal = read.mock.calls.at(-1)?.[1];
    panel.handleInput("?");
    expect(signal?.aborted).toBe(true);
    if (outcome === "return") panel.handleInput("\u001b");
    if (outcome === "quit") panel.handleInput("q");
    if (outcome === "dispose") panel.dispose();
    await vi.advanceTimersByTimeAsync(0);
    const before = panel.render(36); const renders = terminal.renders;
    resolve?.({ ...result, lines: ["STALE-COMPLETION"] }); await vi.advanceTimersByTimeAsync(0);
    expect(panel.render(36)).toEqual(before);
    expect(panel.render(36).join("\n")).not.toContain("STALE-COMPLETION");
    if (outcome === "return") {
      expect(panel.render(36).join("\n")).toContain("FRESH"); expect(read).toHaveBeenCalledTimes(initialReads + 1);
    } else {
      await vi.advanceTimersByTimeAsync(2100);
      expect(read).toHaveBeenCalledTimes(initialReads); expect(vi.getTimerCount()).toBe(0);
    }
    if (outcome === "quit" || outcome === "dispose") expect(terminal.renders).toBe(renders);
    panel.dispose();
  });
});
