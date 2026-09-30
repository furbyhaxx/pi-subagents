/**
 * widget-tick-leak.test.ts — `session_shutdown` must dispose the widget.
 *
 * The widget arms an animation tick of its own accord and is reachable only
 * from the extension factory, so nothing in the widget's own unit tests can
 * assert that the session teardown tears it down. Left undisposed, the tick
 * survives into the next activation and keeps calling `requestRender()` on a TUI
 * whose subagent panel is gone; worse, any event that lands afterwards re-runs
 * `update()`, which re-registers the widget on a context that no longer exists.
 *
 * Asserting on `dispose` being reached, rather than on renders stopping, is
 * deliberate: an interval left running does clear itself once the manager
 * empties its roster, so "no renders after shutdown" would pass either way and
 * prove nothing. The disposal has to be explicit and it has to be wired.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { AgentWidget } from "../src/ui/agent-widget.js";

function makePi() {
  const lifecycle = new Map<string, any>();
  const busHandlers = new Map<string, (raw: any) => unknown>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        busHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, lifecycle, busHandlers };
}

function ctx(setWidget = vi.fn()) {
  return {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget,
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

describe("session_shutdown disposes the widget", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let dispose: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-widget-tick-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-widget-tick-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
    // Never settles, so there is a live agent when shutdown arrives.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    dispose = vi.spyOn(AgentWidget.prototype, "dispose");
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("tears the widget down with the session that armed it", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    let widgetFactory: any;
    const setWidget = vi.fn((key: string, content: any) => {
      if (key === "agents" && content) widgetFactory = content;
    });
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx(setWidget));

    await busHandlers.get("subagents:rpc:spawn")!({
      requestId: "req-tick",
      type: "general-purpose",
      prompt: "go",
      options: { description: "a running agent" },
    });

    await vi.waitFor(() => expect(widgetFactory, "the widget registered").toBeTypeOf("function"));
    expect(dispose, "nothing has disposed the widget yet").not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")();
    expect(dispose).toHaveBeenCalledTimes(1);
  }, 20_000);
});
