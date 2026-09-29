import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  createWorktree: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
  releaseWorktreeLease: vi.fn(),
  resumeWorktree: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";

const mockPi = {} as ExtensionAPI;
const mockCtx = { cwd: "/tmp" } as ExtensionContext;

type RunResult = Awaited<ReturnType<typeof runAgent>>;

function mockSession(): AgentSession {
  return { dispose: vi.fn() } as unknown as AgentSession;
}

function heldRun() {
  let finish!: (result: RunResult) => void;
  vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(mockSession());
    return new Promise(resolve => { finish = resolve; });
  });
  return { finish: (result: RunResult) => finish(result) };
}

function heldRunOnce() {
  let finish!: (result: RunResult) => void;
  vi.mocked(runAgent).mockImplementationOnce((_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(mockSession());
    return new Promise(resolve => { finish = resolve; });
  });
  return { finish: (value: RunResult) => finish(value) };
}

function result(text: string, session = mockSession()): RunResult {
  return { responseText: text, session, aborted: false, steered: false };
}

describe("AgentManager stop and detach", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.clearAllMocks();
  });

  it("keeps a stopped record and allows resuming a wedged run", async () => {
    const oldRun = heldRun();
    manager = new AgentManager(undefined, 1);
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", {
      description: "wedged run",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(await manager.stop(id, 0)).toBe(true);
    expect(manager.getRecord(id)).toBe(record);
    expect(record.status).toBe("stopped");
    expect(manager.isRunActive(id)).toBe(false);
    expect(await manager.stop(id, 0)).toBe(true);

    let finishResume!: (value: { text: string }) => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(resolve => { finishResume = resolve; }));
    await manager.resume(id, "continue", undefined, { isBackground: true });
    expect(record.status).toBe("running");
    const queuedId = manager.spawn(mockPi, mockCtx, "general-purpose", "waiter", {
      description: "waiting agent",
      isBackground: true,
    });
    expect(manager.getRecord(queuedId)?.status).toBe("queued");

    oldRun.finish(result("late old result"));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(manager.getRecord(queuedId)?.status).toBe("queued");
    expect(record.status).toBe("running");
    expect(record.result).toBeUndefined();

    const resumedRun = record.promise;
    finishResume({ text: "resumed result" });
    await resumedRun;
    expect(record.status).toBe("completed");
    expect(record.result).toBe("resumed result");
    expect(manager.getRecord(queuedId)?.status).toBe("running");
  });

  it("releases a pool slot once and can stop a queued record", async () => {
    const firstRun = heldRunOnce();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);
    const firstId = manager.spawn(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
      isBackground: true,
    });
    const secondId = manager.spawn(mockPi, mockCtx, "general-purpose", "second", {
      description: "second",
      isBackground: true,
    });

    expect(manager.getRecord(secondId)?.status).toBe("queued");
    await manager.stop(firstId, 0);
    expect(manager.getRecord(secondId)?.status).toBe("running");

    const thirdId = manager.spawn(mockPi, mockCtx, "general-purpose", "third", {
      description: "third",
      isBackground: true,
    });
    expect(manager.getRecord(thirdId)?.status).toBe("queued");
    expect(await manager.stop(thirdId, 0)).toBe(true);
    expect(manager.getRecord(thirdId)?.status).toBe("stopped");

    firstRun.finish(result("late settlement"));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(manager.getRecord(firstId)?.status).toBe("stopped");
    expect(manager.getRecord(secondId)?.status).toBe("running");
    expect(manager.getRecord(thirdId)?.status).toBe("stopped");
  });
});
