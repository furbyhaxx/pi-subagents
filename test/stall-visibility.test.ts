import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentManager, getAgentStallStatus } from "../src/agent-manager.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { AgentWidget, type Theme } from "../src/ui/agent-widget.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent, type ToolActivity } from "../src/agent-runner.js";

const theme: Theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
let hermetic: ReturnType<typeof hermeticDir> | undefined;

afterEach(() => {
  hermetic?.restore();
  hermetic = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "stall-id",
    type: "general-purpose",
    description: "watch idle state",
    status: "running",
    toolUses: 0,
    startedAt: 0,
    lastActivityAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    session: { messages: [], subscribe: () => () => {} } as never,
    ...overrides,
  };
}

describe("stall visibility", () => {
  it("marks only activity strictly beyond the threshold, and zero disables it", () => {
    expect(getAgentStallStatus(0, 5, 300_000)).toMatchObject({ idleMs: 300_000, stalled: false });
    expect(getAgentStallStatus(0, 5, 300_001)).toMatchObject({ stalled: true });
    expect(getAgentStallStatus(0, 0, 3_600_000)).toMatchObject({ stalled: false });
  });

  it("refreshes activity time on tool start/end and assistant deltas", async () => {
    vi.useFakeTimers();
    const now = 2_000_000;
    vi.setSystemTime(now);
    hermetic = hermeticDir({
      settings: { schedulingEnabled: false, workflowsEnabled: false, stallThresholdMinutes: 1 },
    });
    let onToolActivity: ((activity: ToolActivity) => void) | undefined;
    let onTextDelta: ((delta: string, fullText: string) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      onToolActivity = options.onToolActivity;
      onTextDelta = options.onTextDelta;
      return new Promise(() => {});
    });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const spawned = await tools.get("Agent")!.execute(
      "spawn",
      { prompt: "wait", description: "activity time", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx({ cwd: hermetic.dir }),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    if (!id) throw new Error("spawn result did not include an agent ID");

    for (const update of [
      () => onToolActivity?.({ type: "start", toolName: "read" }),
      () => onToolActivity?.({ type: "end", toolName: "read" }),
      () => onTextDelta?.("answer", "answer"),
    ]) {
      vi.setSystemTime(Date.now() + 61_000);
      update();
      const result = await tools.get("get_subagent_result")!.execute(
        "activity", { agent_id: id }, undefined, undefined, ctx({ cwd: hermetic.dir }),
      );
      expect(textOf(result)).toContain("Idle: 0s");
      expect(textOf(result)).not.toContain("(stalled)");
    }

    await lifecycle.get("session_shutdown")?.();
  });

  it("shows idle time, stalled state, and recovery hint in get_subagent_result", async () => {
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now);
    hermetic = hermeticDir({
      settings: { schedulingEnabled: false, workflowsEnabled: false, stallThresholdMinutes: 1 },
    });
    const { pi, tools, lifecycle } = makePi();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    subagentsExtension(pi);
    const spawned = await tools.get("Agent")!.execute(
      "spawn",
      { prompt: "wait", description: "stall output", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx({ cwd: hermetic.dir }),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    if (!id) throw new Error("spawn result did not include an agent ID");
    vi.setSystemTime(now + 61_000);

    const result = await tools.get("get_subagent_result")!.execute(
      "result", { agent_id: id }, undefined, undefined, ctx({ cwd: hermetic.dir }),
    );

    expect(textOf(result)).toContain("Idle: 1m 1s (stalled)");
    expect(textOf(result)).toContain("Use steer_subagent, update_subagent {interrupt: true}, or stop_subagent.");
    await lifecycle.get("session_shutdown")?.();
  });

  it("shows idle/stalled and recovery hint in the widget row", () => {
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now + 61_000);
    const agent = record({ lastActivityAt: now });
    const manager = { listAgents: () => [agent] } as unknown as AgentManager;
    let render: (() => string[]) | undefined;
    const widget = new AgentWidget(manager, new Map(), () => "all", undefined, undefined, () => 1);
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => {
        if (typeof content === "function") {
          const view = content({ terminal: { columns: 160 }, requestRender: () => {} }, theme);
          render = () => view.render();
        }
      },
    });
    widget.update();
    const lines = render?.().join("\n") ?? "";

    expect(lines).toContain("idle 1m 1s");
    expect(lines).toContain("STALLED");
    expect(lines).toContain("update_subagent {interrupt: true}");
    widget.dispose();
  });

  it("shows idle/stalled on the fleet row with one shared recovery hint", () => {
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now + 61_000);
    const agent = record({ lastActivityAt: now });
    const manager = { listAgents: () => [agent] } as unknown as AgentManager;
    let render: ((width: number) => string[]) | undefined;
    const ui: FleetUICtx = {
      setWidget: (_key, content) => {
        if (typeof content === "function") {
          const view = content({ terminal: { columns: 160 }, requestRender: () => {} }, theme);
          render = width => view.render(width);
        }
      },
      onTerminalInput: () => () => {},
      getEditorText: () => "",
      notify: () => {},
      custom: async () => undefined,
    };
    const fleet = new FleetList(manager, new Map(), undefined, undefined, undefined, undefined, undefined, () => 1);
    fleet.setUICtx(ui);
    fleet.update();
    const lines = render?.(160).join("\n") ?? "";

    expect(lines).toContain("idle 1m 1s");
    expect(lines).toContain("STALLED");
    expect(lines).toContain("update_subagent {interrupt: true}");
    expect(lines).toContain("stop_subagent");
    fleet.dispose();
  });
});
