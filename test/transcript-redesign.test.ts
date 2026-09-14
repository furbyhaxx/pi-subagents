import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const now = 1_700_000_000_000;

function tui(rows = 24, columns = 80) {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as any;
}

function record(overrides: Partial<AgentRecord & { taskPrompt: string }> = {}) {
  return {
    id: "parent",
    type: "general-purpose",
    description: "inspect transcript",
    status: "running",
    toolUses: 0,
    startedAt: now,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  } as AgentRecord & { taskPrompt?: string };
}

function session(messages: any[] = [], branch: any[] = []) {
  let listener: ((event: any) => void) | undefined;
  return {
    messages,
    sessionManager: { getBranch: vi.fn(() => branch) },
    subscribe: vi.fn((next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; }),
    emit: (event: any) => listener?.(event),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

function assistant(content: any[], timestamp = now) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp,
  };
}

function result(id: string, text: string, details?: unknown) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    details,
    isError: false,
    timestamp: now + 1,
  };
}

function viewer(messages: any[], options: { rows?: number; rec?: AgentRecord & { taskPrompt?: string }; done?: () => void } = {}) {
  const fakeSession = session(messages);
  const component = new ConversationViewer(
    tui(options.rows ?? 24), fakeSession, options.rec ?? record({ taskPrompt: "task" }), undefined,
    plainTheme, options.done ?? vi.fn(), undefined, undefined, undefined, false,
    () => "off", undefined, () => "steps",
  );
  return { component, fakeSession };
}

describe("approved transcript interactions", () => {
  it("keeps a 10k-line task internally scrollable with history and protected footer at 40x12", () => {
    const task = Array.from({ length: 10_000 }, (_, index) => `task row ${index + 1}`).join("\n");
    const { component } = viewer([assistant([{ type: "text", text: "history row" }])], {
      rows: 12,
      rec: record({ taskPrompt: task, status: "completed" }),
    });
    component.render(40);
    const beforeKey = (component as any).selectedKey;

    component.handleInput("t");
    component.handleInput("\x1b[F");
    const rendered = component.render(40).join("\n");

    expect(component.render(40).length).toBeLessThanOrEqual(8);
    expect(rendered).toContain("task row 10000");
    expect(component.render(80).join("\n")).toContain("task row 10000");
    expect(rendered).toContain("history row");
    expect(rendered).toContain("Esc close");
    component.handleInput("t");
    expect((component as any).selectedKey).toBe(beforeKey);
  });

  it("expands rollups into selectable child rows and traverses parent/preview", () => {
    const messages: any[] = [];
    for (let index = 0; index < 5; index++) {
      const id = `read-${index}`;
      messages.push(assistant([{ type: "toolCall", id, name: "read", arguments: { path: `src/${index}.ts` } }], now + index));
      messages.push(result(id, `body ${index}`));
    }
    const { component } = viewer(messages);
    component.render(80);
    const rollup = (component as any).selectedKey;

    component.handleInput("\x1b[C");
    expect((component as any).selectedKey).toBe(rollup);
    component.handleInput("\x1b[B");
    expect(component.render(80).join("\n")).toContain("src/0.ts");
    component.handleInput("\x1b[B");
    expect(component.render(80).join("\n")).toContain("src/1.ts");
    component.handleInput("\x1b[C");
    component.handleInput("\x1b[C");
    expect((component as any).readingRegion).toBe("preview");
    component.handleInput("\x1b[D");
    component.handleInput("\x1b[D");
    component.handleInput("\x1b[D");
    expect((component as any).selectedKey).toBe(rollup);
  });

  it("windows preview from the original source and Detail reaches the retained tail", () => {
    const body = Array.from({ length: 200 }, (_, index) => `${index + 1}: ${"x".repeat(100)}`).join("\n");
    const messages = [
      assistant([{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "npm test" } }]),
      result("bash", body),
    ];
    const { component } = viewer(messages, { rows: 12 });
    component.render(40);
    component.handleInput("\x1b[C");
    component.handleInput("\x1b[C");
    component.render(40);
    const node = (component as any).focusedNode();
    const previewRows = (component as any).previewRows(node, 36).map((row: any) => row.text);
    expect(previewRows).toContain("160 lines hidden · o full");
    const omission = previewRows.indexOf("160 lines hidden · o full");
    (component as any).previewOffset = omission;
    component.handleInput("o");
    expect(component.render(40).join("\n")).toContain("31:");
    component.handleInput("\x1b");
    expect((component as any).previewOffset).toBe(omission);

    expect(previewRows.some((line: string) => line.startsWith("200:"))).toBe(true);
    component.handleInput("\x1b[F");
    expect(component.render(40).join("\n")).toContain("xxxx");
    component.handleInput("o");
    const detailLines = (component as any).detailLines(36);
    expect(detailLines.some((line: string) => line.startsWith("200:"))).toBe(true);
    component.handleInput("\x1b[F");
    expect(component.render(40).join("\n")).toContain("xxxx");
    component.handleInput("\x1b");
    expect((component as any).readingRegion).toBe("preview");
  });

  it("preserves a paused Steps snapshot across a no-navigation Tab roundtrip", () => {
    const messages = Array.from({ length: 12 }, (_, index) => assistant([{ type: "text", text: `note ${index}` }], now + index));
    const { component } = viewer(messages);
    component.render(80);
    component.handleInput("\x1b[A");
    const before = (component as any).captureView();

    component.handleInput("\t");
    component.render(80);
    component.handleInput("\t");
    const after = (component as any).captureView();

    expect(after).toMatchObject(before);
    expect(after.following).toBe(false);
  });

  it("holds a paused source identity across append and End alone resumes follow", () => {
    const messages = Array.from({ length: 5 }, (_, index) => assistant([{ type: "text", text: `note ${index}` }], now + index));
    const { component, fakeSession } = viewer(messages);
    component.render(80);
    component.handleInput("\x1b[A");
    const selected = (component as any).selectedKey;
    const appended = assistant([{ type: "text", text: "new note" }], now + 20);
    messages.push(appended);
    fakeSession.emit({
      type: "entry_appended",
      entry: { type: "message", id: "new-entry", parentId: null, timestamp: new Date(now + 20).toISOString(), message: appended },
    });

    expect(component.render(80).join("\n")).toContain("Paused +1");
    component.render(80);
    expect(fakeSession.sessionManager.getBranch).toHaveBeenCalledOnce();
    expect((component as any).selectedKey).toBe(selected);
    component.handleInput("\x1b[F");
    expect(component.render(80).join("\n")).toContain("Following");
  });

  it("Help consumes stop keys and returns to the exact parent layer", () => {
    const stop = vi.fn();
    const fakeSession = session([]);
    const component = new ConversationViewer(
      tui(), fakeSession, record(), undefined, plainTheme, vi.fn(), stop,
      undefined, undefined, false, () => "off", undefined, () => "steps",
    );
    component.handleInput("x");
    component.handleInput("?");
    component.handleInput("x");
    component.handleInput("?");
    component.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
  });

  it("requires an explicit identity choice when a spawn resolves to multiple children", () => {
    const parentSession = session([
      assistant([{ type: "toolCall", id: "spawn-many", name: "Agent", arguments: { description: "children", subagent_type: "Explore" } }]),
      result("spawn-many", "started"),
    ]);
    const children = ["child-a", "child-b"].map((id) => ({
      record: record({ id, type: "Explore", description: id }),
      session: session([assistant([{ type: "text", text: id }])]),
    }));
    const component = new ConversationViewer(
      tui(), parentSession, record(), undefined, plainTheme, vi.fn(), undefined,
      undefined, undefined, false, () => "off", undefined, () => "steps", undefined,
      { resolveChildren: () => children },
    );
    component.render(80);
    component.handleInput("O");

    expect((component as any).childViewer).toBeUndefined();
    expect(component.render(80).join("\n")).toContain("Select a child, then press O.");
    expect((component as any).flatSteps().filter((node: any) => node.owner)).toHaveLength(2);
  });

  it("opens the resolved child with child-specific steer/stop and Esc returns paused", () => {
    const parentDone = vi.fn();
    const parentSession = session([
      assistant([{ type: "toolCall", id: "spawn", name: "Agent", arguments: { description: "child work", subagent_type: "Explore" } }]),
      result("spawn", "started", { agentId: "child" }),
    ]);
    const childSteer = vi.fn();
    const childStop = vi.fn();
    const child = {
      record: record({ id: "child", type: "Explore", description: "child work", taskPrompt: "child task" }),
      session: session([assistant([{ type: "text", text: "child transcript" }])]),
      onSteer: childSteer,
      onStop: childStop,
    };
    const component = new ConversationViewer(
      tui(), parentSession, record(), undefined, plainTheme, parentDone, undefined,
      undefined, undefined, false, () => "off", undefined, () => "steps", undefined,
      { resolveChildren: () => [child] },
    );
    component.render(80);
    component.handleInput("O");
    expect(component.render(80).join("\n")).toContain("from general-purpose");
    component.handleInput("\r");
    component.handleInput("g");
    component.handleInput("o");
    component.handleInput("\r");
    expect(childSteer).toHaveBeenCalledWith("go");
    component.handleInput("x");
    component.handleInput("x");
    expect(childStop).toHaveBeenCalledOnce();
    component.handleInput("\x1b");
    expect(parentDone).not.toHaveBeenCalled();
    expect((component as any).following).toBe(false);
    component.handleInput("\x1b");
    expect(parentDone).toHaveBeenCalledOnce();
  });
});
