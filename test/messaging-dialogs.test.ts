import { type Component, CURSOR_MARKER, isFocusable, stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlackboardEntry, OperatorPutResult } from "../src/messaging/types.js";
import * as dialogs from "../src/ui/blackboard-dialogs.js";
import { BlackboardReadDialog, BlackboardValueEditor } from "../src/ui/blackboard-dialogs.js";
import { BlackboardPanel } from "../src/ui/blackboard-panel.js";
import * as common from "../src/ui/messaging-panel-common.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const info = { scopeKey: "test", scopeMode: "project" as const, databasePath: "/tmp/test.db", operatorTopicPrefix: "operator/", sessionId: "own", transport: "socket" as const };
const entry: BlackboardEntry = { topic: "operator/constraints", key: "policy", value: "initial", revision: 3, entryToken: 7, author: "operator", authorAgentId: null, authorSessionId: "own", createdAt: 1, updatedAt: 1, expiresAt: null };
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };

function nativeTui(rows = 12) {
  const terminal = {
    rows, columns: 40, kittyProtocolActive: false,
    start() {}, stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  } satisfies Terminal;
  const tui = new TuiMainScreen(terminal);
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  return { tui, terminal };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function flowHarness(entries: BlackboardEntry[] = [entry]) {
  const { tui, terminal } = nativeTui();
  const stack: (Component & { dispose?(): void })[] = [];
  function open<T>(make: (done: (result: T) => void) => Component & { dispose?(): void }): Promise<T> {
    return new Promise(resolve => {
      const component = make(result => {
        expect(stack.pop()).toBe(component);
        component.dispose?.();
        const previous = stack.at(-1);
        if (previous && isFocusable(previous)) previous.focused = true;
        resolve(result);
      });
      const previous = stack.at(-1);
      if (previous && isFocusable(previous)) previous.focused = false;
      stack.push(component);
      if (isFocusable(component)) component.focused = true;
    });
  }
  vi.spyOn(common, "showPrefillInput").mockImplementation((_ui, title, placeholder, prefill) => open(done => new common.MessagingPrefillInput(title, placeholder, prefill, theme, () => terminal.rows, done)));
  vi.spyOn(dialogs, "showBlackboardValueEditor").mockImplementation((_ui, title, target, prefill) => open(done => new BlackboardValueEditor(tui, theme, title, target, prefill,
    () => open(targetDone => new BlackboardReadDialog("Target", `topic ${target.topic}\nkey ${target.key}\nrev ${target.revision ?? "new entry"}\nauthor ${target.author}`, "esc back to your text", "target", theme, () => terminal.rows, targetDone)), done)));
  vi.spyOn(dialogs, "showBlackboardAcknowledgement").mockImplementation((_ui, target, text, chooseKey) => open(done => new BlackboardReadDialog(`${target} · nothing written`, text, chooseKey ? "⏎ choose another key · esc discard" : "⏎ back to your text · esc discard", "ack", theme, () => terminal.rows, done)));
  const service = {
    boardList: vi.fn(() => entries), boardRecentLog: vi.fn(() => []), getPanelInfo: () => info,
    operatorPut: vi.fn((): OperatorPutResult => ({ ok: true, entry })),
    operatorDelete: vi.fn(() => ({ ok: true as const, op: "delete" as const, entry })),
    operatorExpire: vi.fn(() => ({ ok: true as const, op: "expire" as const, entry })),
  };
  const ui = { custom: vi.fn(), notify: vi.fn(), select: vi.fn() };
  const done = vi.fn();
  const panel = new BlackboardPanel(tui, theme, done, service, ui, { entries, info });
  const render = () => stack.at(-1)?.render(36) ?? panel.render(36);
  return {
    panel, service, ui, done, terminal, stack, render,
    screen: () => stripTerminalSequences(render().join("\n")),
    async press(data: string) { render(); (stack.at(-1) ?? panel).handleInput?.(data); await tick(); },
  };
}

describe("bounded native value editor", () => {
  it("pins context and five native value lines, keeps caret/draft on resize, and inserts literal q and newlines", () => {
    const { tui, terminal } = nativeTui();
    const submit = vi.fn();
    const editor = new BlackboardValueEditor(tui, theme, "Edit value", { ...entry }, "one\ntwo\nthree\nfour\nfive\nsix", async () => "cancel", submit);
    editor.focused = true;
    const first = editor.render(36);
    expect(first).toHaveLength(11);
    expect(first[1]).toContain("policy · rev 3");
    expect(first.filter(line => ["two", "three", "four", "five", "six"].some(value => line.includes(value)))).toHaveLength(5);
    expect(first.some(line => line.includes(CURSOR_MARKER) && line.includes("six"))).toBe(true);
    editor.handleInput("q"); editor.handleInput("\x1b[13;2u"); editor.handleInput("seven");
    const compact = editor.render(36);
    expect(compact[1]).toBe(first[1]);
    expect(compact.some(line => line.includes(CURSOR_MARKER) && line.includes("seven"))).toBe(true);
    terminal.rows = 24;
    expect(editor.render(72)).toHaveLength(18);
    terminal.rows = 12;
    expect(editor.render(36)).toEqual(compact);
    editor.handleInput("\\"); editor.handleInput("\r"); editor.handleInput("eight"); editor.handleInput("\r");
    expect(submit).toHaveBeenCalledExactlyOnceWith({ kind: "submit", text: "one\ntwo\nthree\nfour\nfive\nsixq\nseven\neight" });
    expect(compact.every(line => visibleWidth(line) === 36)).toBe(true);
    editor.dispose();
  });

  it("preserves raw whitespace and expanded native paste when submitting", () => {
    const { tui } = nativeTui(); const done = vi.fn();
    const editor = new BlackboardValueEditor(tui, theme, "Value", { ...entry, revision: null }, "  raw  ", async () => "cancel", done);
    editor.handleInput("\x1b[200~\nkept\n\x1b[201~"); editor.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ kind: "submit", text: "  raw  \nkept\n" });
    editor.dispose();
  });

  it("keeps revision and recognizable long key, omitting JSON hint before truncating key", () => {
    const { tui } = nativeTui();
    const editor = new BlackboardValueEditor(tui, theme, "Edit", { ...entry, key: "recognizable-".repeat(20), revision: 123456 }, "", async () => "cancel", vi.fn());
    expect(editor.render(36)).toHaveLength(11);
    const context = stripTerminalSequences(editor.render(36)[1]);
    expect(context).toContain("recognizable-");
    expect(context).toContain("rev 123456");
    expect(context).not.toContain("JSON");
    expect(visibleWidth(context)).toBe(36);
    editor.dispose();
  });

  it("full target inspection returns to exactly the same native draft, caret and scroll", async () => {
    const f = flowHarness([{ ...entry, topic: `operator/${"long-topic-".repeat(9)}`, key: `${"long-key-".repeat(12)}ENDKEY`, value: "one\ntwo\nthree\nfour\nfive\nsix" }]);
    await f.press("\r"); await f.press("e"); await f.press("\x1b[D");
    const before = f.render();
    await f.press("\x0f");
    expect(f.stack).toHaveLength(2);
    expect(f.screen()).toContain("Target");
    await f.press("G");
    expect(f.screen()).toContain("ENDKEY");
    expect(f.screen()).toContain("author operator");
    await f.press("\x1b");
    expect(f.render()).toEqual(before);
    await f.press("q"); await f.press("\r");
    expect(f.service.operatorPut).toHaveBeenCalledWith(expect.objectContaining({ value: "one\ntwo\nthree\nfour\nfive\nsiqx", expectedToken: 7 }));
    f.panel.dispose();
  });

  it.each(["\x1b", "\x03"])("native cancel %j writes nothing", async key => {
    const f = flowHarness(); await f.press("\r"); await f.press("e"); await f.press(key);
    expect(f.service.operatorPut).not.toHaveBeenCalled();
    expect(f.stack).toHaveLength(0);
    expect(f.done).not.toHaveBeenCalled();
    f.panel.dispose();
  });

  it.each(["q", "\x03"])("quits outright from target with %j and discards the draft", async key => {
    const f = flowHarness(); await f.press("\r"); await f.press("e"); await f.press("q"); await f.press("\x0f"); await f.press(key);
    expect(f.done).toHaveBeenCalledOnce();
    expect(f.stack).toHaveLength(0);
    expect(f.service.operatorPut).not.toHaveBeenCalled();
    expect(f.service.boardList).not.toHaveBeenCalled();
  });

  it("surfaces the unavailable public external-editor path without changing text", () => {
    const { tui } = nativeTui(); const done = vi.fn();
    const editor = new BlackboardValueEditor(tui, theme, "Edit", entry, "draft", async () => "cancel", done);
    editor.handleInput("\x07");
    expect(stripTerminalSequences(editor.render(36).join("\n"))).toContain("External editor unavailable here.");
    editor.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ kind: "submit", text: "draft" });
    editor.dispose();
  });
});

describe("acknowledgement-first retry", () => {
  it("keeps occupied-key refusal fully scrollable with no input, mutation or refresh until acknowledged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = flowHarness();
    f.service.operatorPut.mockReturnValueOnce({ ok: false, reason: "entry-changed", current: entry });
    await f.press("n"); await f.press("\r"); await f.press("policy"); await f.press("\r"); await f.press("kept q"); await f.press("\r");
    expect(f.stack).toHaveLength(1);
    expect(f.stack[0]).toBeInstanceOf(BlackboardReadDialog);
    expect(f.screen()).toContain("already exists");
    expect(f.ui.notify).not.toHaveBeenCalled();
    expect(f.service.operatorPut).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.service.boardList).not.toHaveBeenCalled();
    await f.press("G");
    expect(f.screen().replace(/\s+/g, " ")).toContain("existing entry.");
    expect(f.render().length).toBeLessThanOrEqual(11);
    expect(f.render().every(line => visibleWidth(line) === 36)).toBe(true);
    await f.press("\r");
    expect(f.screen()).toContain("> policy");
    expect(f.service.operatorPut).toHaveBeenCalledOnce();
    await f.press("\x15"); await f.press("other"); await f.press("\r");
    expect(f.screen()).toContain("kept q");
    await f.press("\r");
    expect(f.service.operatorPut).toHaveBeenNthCalledWith(2, { topic: entry.topic, key: "other", value: "kept q", expectedToken: null });
    f.panel.dispose();
  });

  it.each(["\x1b", "q", "\x03"])("discards an occupied draft from ACK with %j without another attempt", async key => {
    const f = flowHarness(); f.service.operatorPut.mockReturnValue({ ok: false, reason: "entry-changed", current: entry });
    await f.press("n"); await f.press("\r"); await f.press("policy"); await f.press("\r"); await f.press("draft"); await f.press("\r"); await f.press(key);
    expect(f.stack).toHaveLength(0);
    expect(f.service.operatorPut).toHaveBeenCalledOnce();
    expect(f.ui.notify).not.toHaveBeenCalled();
    if (key === "\x1b") { expect(f.done).not.toHaveBeenCalled(); expect(f.service.boardList).toHaveBeenCalledOnce(); }
    else expect(f.done).toHaveBeenCalledOnce();
    f.panel.dispose();
  });

  it("acknowledges invalid topic and blank key before reopening the exact field drafts, without writing", async () => {
    const f = flowHarness();
    await f.press("n"); await f.press("\x15"); await f.press("invalid q"); await f.press("\r");
    expect(f.screen()).toContain("Operator entries must be under");
    expect(f.stack[0]).toBeInstanceOf(BlackboardReadDialog);
    await f.press("\r");
    expect(f.screen()).toContain("> invalid q");
    await f.press("\x15"); await f.press("operator/test"); await f.press("\r"); await f.press("   "); await f.press("\r");
    expect(f.screen()).toContain("A key is required.");
    await f.press("\r");
    expect(common.showPrefillInput).toHaveBeenLastCalledWith(f.ui, "Key", "no-direct-db-writes", "   ");
    expect(f.service.operatorPut).not.toHaveBeenCalled();
    expect(f.ui.notify).not.toHaveBeenCalled();
    await f.press("\x1b"); f.panel.dispose();
  });

  it.each(["topic", "key"])("returns to keys when cancelling %s validation acknowledgement", async field => {
    const f = flowHarness(); await f.press("n");
    if (field === "topic") { await f.press("\x15"); await f.press("invalid"); }
    await f.press("\r");
    if (field === "key") await f.press("\r");
    expect(f.stack[0]).toBeInstanceOf(BlackboardReadDialog);
    await f.press("\x1b");
    expect(f.stack).toHaveLength(0);
    await f.press("z"); // clear the retained status note without navigating
    expect(f.screen()).toContain("↑↓ key");
    expect(f.service.operatorPut).not.toHaveBeenCalled();
    f.panel.dispose();
  });

  it.each(["continue", "discard"])("preserves thrown-write draft and fully readable reason on %s", async action => {
    const f = flowHarness();
    f.service.operatorPut.mockImplementationOnce(() => { throw new Error(`database locked ${"long reason ".repeat(25)}END-REASON`); });
    await f.press("\r"); await f.press("e"); await f.press("q"); await f.press("\r");
    expect(f.screen()).toContain("The board could not be written:");
    await f.press("G");
    expect(f.screen()).toContain("END-REASON");
    expect(f.screen()).toContain("Your text is still here.");
    expect(f.ui.notify).not.toHaveBeenCalled();
    if (action === "continue") {
      await f.press("\r"); expect(f.screen()).toContain("initialq");
      expect(f.service.operatorPut).toHaveBeenCalledOnce();
      await f.press("\r"); expect(f.service.operatorPut).toHaveBeenCalledTimes(2);
    } else { await f.press("\x1b"); expect(f.service.operatorPut).toHaveBeenCalledOnce(); }
    f.panel.dispose();
  });

  it.each(["entry-changed", "not-found"] as const)("acknowledges edit %s before using the refreshed context/token", async reason => {
    const f = flowHarness();
    f.service.operatorPut.mockReturnValueOnce({ ok: false, reason, current: reason === "entry-changed" ? { ...entry, revision: 4, entryToken: 9 } : null });
    await f.press("\r"); await f.press("e"); await f.press("q"); await f.press("\r");
    expect(f.stack[0]).toBeInstanceOf(BlackboardReadDialog);
    expect(f.service.operatorPut).toHaveBeenCalledOnce();
    await f.press("\r");
    expect(f.screen()).toContain(reason === "entry-changed" ? "rev 4" : "New ");
    expect(f.screen()).toContain("initialq");
    expect(f.ui.notify).not.toHaveBeenCalled();
    await f.press("\r");
    expect(f.service.operatorPut).toHaveBeenNthCalledWith(2, expect.objectContaining({ value: "initialq", expectedToken: reason === "entry-changed" ? 9 : null }));
    f.panel.dispose();
  });
});
