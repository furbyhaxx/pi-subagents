import { afterEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/pi-retry-adapter.js", async () => {
  const actual = await vi.importActual<typeof import("../src/pi-retry-adapter.js")>("../src/pi-retry-adapter.js");
  return { ...actual, replaceSessionModelCandidates: adapterMocks.replace };
});

import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { replaceSessionModelCandidates } from "../src/pi-retry-adapter.js";
import { ctx, flush, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

type TestModel = { provider: string; id: string; name: string; reasoning: boolean };
type TestSession = {
  model: TestModel;
  thinkingLevel: ModelThinkingLevel;
  messages: unknown[];
  sessionManager: { appendCustomEntry: ReturnType<typeof vi.fn>; getBranch: () => never[] };
  subscribe: ReturnType<typeof vi.fn>;
  setThinkingLevel: (level: ModelThinkingLevel) => void;
};

const availableModel: TestModel = {
  provider: "anthropic",
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  reasoning: true,
};

function makeSession(): TestSession {
  const session: TestSession = {
    model: { provider: "openai", id: "old-model", name: "Old model", reasoning: true },
    thinkingLevel: "low",
    messages: [],
    sessionManager: { appendCustomEntry: vi.fn(), getBranch: () => [] },
    subscribe: vi.fn(() => () => {}),
    setThinkingLevel(level) { session.thinkingLevel = level; },
  };
  return session;
}

function makeContext(cwd: string) {
  const modelRegistry = {
    find: vi.fn((provider: string, id: string) =>
      provider === availableModel.provider && id === availableModel.id ? availableModel : undefined),
    getAvailable: vi.fn(() => [availableModel]),
    getAll: vi.fn(() => [availableModel]),
  };
  return { context: ctx({ cwd, modelRegistry }), modelRegistry };
}

function holdUntilAbort(session: TestSession) {
  vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(session as never);
    return new Promise(resolve => {
      options.signal?.addEventListener("abort", () => resolve({
        responseText: "interrupted",
        session: session as never,
        aborted: true,
        steered: false,
      }));
    });
  });
}

function installModelSwitchMock() {
  vi.mocked(replaceSessionModelCandidates).mockImplementation(async (session, candidates, _signal, onTransition) => {
    const live = session as unknown as TestSession;
    const candidate = candidates[0];
    live.model = candidate.model as unknown as TestModel;
    const thinking = clampThinkingLevel(candidate.model, candidate.thinking ?? live.thinkingLevel);
    live.setThinkingLevel(thinking);
    onTransition?.({ candidate, thinking, reason: "override", selection: candidates.map(item => item.input) });
  });
}

async function spawn(tools: ReturnType<typeof makePi>["tools"], cwd: string) {
  return tools.get("Agent")!.execute(
    "spawn",
    { prompt: "work", description: "update test", subagent_type: "general-purpose", name: "worker-alias", run_in_background: true },
    undefined,
    undefined,
    ctx({ cwd }),
  );
}

describe("update_subagent tool", () => {
  let hermetic: ReturnType<typeof hermeticDir> | undefined;

  afterEach(async () => {
    if (hermetic) hermetic.restore();
    hermetic = undefined;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("changes the running session model and clamped thinking level", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const session = makeSession();
    holdUntilAbort(session);
    installModelSwitchMock();
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { context } = makeContext(hermetic.dir);
    const spawned = await spawn(tools, hermetic.dir);
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    if (!id) throw new Error("spawn result did not include an agent ID");
    const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as AgentManager;
    const record = manager.getRecord(id);
    if (!record) throw new Error("spawned agent record was not registered");
    record.branch = "feature/model-switch";

    const result = await tools.get("update_subagent")!.execute(
      "update", { agent_id: "worker-alias", model: "anthropic/claude-haiku-4-5", thinking: "high" },
      undefined, undefined, context,
    );

    expect(replaceSessionModelCandidates).toHaveBeenCalledWith(
      session,
      [expect.objectContaining({ input: "anthropic/claude-haiku-4-5", model: availableModel })],
      undefined,
      expect.any(Function),
    );
    expect(session.model).toBe(availableModel);
    expect(session.thinkingLevel).toBe("high");
    expect(textOf(result)).toContain(`Agent ${id} updated.`);
    expect(textOf(result)).toContain("Model: anthropic/claude-haiku-4-5");
    expect(textOf(result)).toContain("Thinking: high");
    expect(textOf(result)).toContain("Interrupted: no");
    expect(textOf(result)).toContain("Requested branch: feature/model-switch (workspace pending)");
    await lifecycle.get("session_shutdown")?.();
  });

  it("changes only thinking without replacing the current model", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const session = makeSession();
    session.model.reasoning = false;
    const currentModel = session.model;
    holdUntilAbort(session);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { context } = makeContext(hermetic.dir);
    await spawn(tools, hermetic.dir);

    const result = await tools.get("update_subagent")!.execute(
      "thinking-only", { agent_id: "worker-alias", thinking: "high" }, undefined, undefined, context,
    );

    expect(replaceSessionModelCandidates).not.toHaveBeenCalled();
    expect(session.model).toBe(currentModel);
    expect(session.thinkingLevel).toBe("off");
    expect(textOf(result)).toContain("Thinking: off");
    await lifecycle.get("session_shutdown")?.();
  });

  it("stops then resumes the same conversation with the new candidates", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const session = makeSession();
    holdUntilAbort(session);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "continued" } as never);
    installModelSwitchMock();
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { context } = makeContext(hermetic.dir);
    const spawned = await spawn(tools, hermetic.dir);
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    if (!id) throw new Error("spawn result did not include an agent ID");

    const result = await tools.get("update_subagent")!.execute(
      "interrupt", { agent_id: id, model: "anthropic/claude-haiku-4-5", thinking: "high", interrupt: true },
      undefined, undefined, context,
    );
    await flush();

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(resumeAgent).toHaveBeenCalledWith(
      session,
      "Continue where you left off.\n\nThe previous turn was interrupted to switch model.",
      expect.objectContaining({
        modelCandidates: [expect.objectContaining({ input: "anthropic/claude-haiku-4-5", thinking: "high" })],
      }),
    );
    expect(textOf(result)).toContain(`Agent ${id} updated.`);
    expect(textOf(result)).toContain("Model: anthropic/claude-haiku-4-5");
    expect(textOf(result)).toContain("Thinking: high");
    expect(textOf(result)).toContain("Interrupted: yes");
    await lifecycle.get("session_shutdown")?.();
  });

  it("force-detaches a wedged run and resumes it on the same ID", async () => {
    vi.useFakeTimers();
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const session = makeSession();
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session as never);
      return new Promise(() => {});
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "unstuck" } as never);
    installModelSwitchMock();
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { context } = makeContext(hermetic.dir);
    const spawned = await spawn(tools, hermetic.dir);
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    if (!id) throw new Error("spawn result did not include an agent ID");

    const update = tools.get("update_subagent")!.execute(
      "wedged", { agent_id: id, model: "anthropic/claude-haiku-4-5", interrupt: true },
      undefined, undefined, context,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await update;

    expect(resumeAgent).toHaveBeenCalledWith(
      session,
      expect.stringContaining("previous turn was interrupted to switch model"),
      expect.objectContaining({ modelCandidates: [expect.objectContaining({ model: availableModel })] }),
    );
    expect(textOf(result)).toContain(`Agent ${id} updated.`);
    await lifecycle.get("session_shutdown")?.();
  });

  it("requires a model or thinking update", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const session = makeSession();
    holdUntilAbort(session);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { context } = makeContext(hermetic.dir);
    await spawn(tools, hermetic.dir);

    const result = await tools.get("update_subagent")!.execute(
      "empty-update", { agent_id: "worker-alias" }, undefined, undefined, context,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("at least one of model or thinking");
    await lifecycle.get("session_shutdown")?.();
  });

  it("rejects an unknown thinking level without switching", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const session = makeSession();
    holdUntilAbort(session);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { context } = makeContext(hermetic.dir);
    await spawn(tools, hermetic.dir);

    const result = await tools.get("update_subagent")!.execute(
      "invalid-thinking", { agent_id: "worker-alias", thinking: "imaginary" }, undefined, undefined, context,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown thinking level: "imaginary"');
    expect(replaceSessionModelCandidates).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.();
  });

  it("returns an error for an unresolvable model without switching", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const session = makeSession();
    holdUntilAbort(session);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { context } = makeContext(hermetic.dir);
    await spawn(tools, hermetic.dir);

    const result = await tools.get("update_subagent")!.execute(
      "unknown-model", { agent_id: "worker-alias", model: "not-a-real-model" }, undefined, undefined, context,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Model not found");
    expect(textOf(result)).not.toContain("invented-provider");
    expect(replaceSessionModelCandidates).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.();
  });

  it("directs a stopped agent to resume with model and thinking", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const session = makeSession();
    holdUntilAbort(session);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { context } = makeContext(hermetic.dir);
    const spawned = await spawn(tools, hermetic.dir);
    await flush();
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    if (!id) throw new Error("spawn result did not include an agent ID");
    await tools.get("stop_subagent")!.execute("stop", { agent_id: id }, undefined, undefined, context);

    const result = await tools.get("update_subagent")!.execute(
      "not-running", { agent_id: id, model: "anthropic/claude-haiku-4-5", thinking: "high" },
      undefined, undefined, context,
    );

    expect(textOf(result)).toContain("Agent({resume, model, thinking})");
    expect(replaceSessionModelCandidates).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.();
  });

  it("Agent resume applies explicit model and thinking to a stopped conversation", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const session = makeSession();
    holdUntilAbort(session);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" } as never);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { context } = makeContext(hermetic.dir);
    const spawned = await spawn(tools, hermetic.dir);
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    if (!id) throw new Error("spawn result did not include an agent ID");
    await tools.get("stop_subagent")!.execute("stop", { agent_id: id }, undefined, undefined, context);

    const resumed = await tools.get("Agent")!.execute("resume", {
      prompt: "continue",
      description: "resume settings",
      subagent_type: "general-purpose",
      resume: id,
      model: "anthropic/claude-haiku-4-5",
      thinking: "high",
      run_in_background: true,
    }, undefined, undefined, context);

    expect(textOf(resumed)).toContain("resumed in background");
    expect(resumeAgent).toHaveBeenCalledWith(
      session,
      "continue",
      expect.objectContaining({
        modelCandidates: [expect.objectContaining({ input: "anthropic/claude-haiku-4-5", thinking: "high" })],
      }),
    );
    await lifecycle.get("session_shutdown")?.();
  });

  it("Agent resume applies explicit model and thinking to an errored conversation", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const session = makeSession();
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session as never);
      return Promise.reject(new Error("initial run failed"));
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" } as never);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { context } = makeContext(hermetic.dir);
    const spawned = await spawn(tools, hermetic.dir);
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    if (!id) throw new Error("spawn result did not include an agent ID");
    await flush();
    const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as AgentManager;
    expect(manager.getRecord(id)?.status).toBe("error");

    const resumed = await tools.get("Agent")!.execute("resume-error", {
      prompt: "continue",
      description: "resume error settings",
      subagent_type: "general-purpose",
      resume: id,
      model: "anthropic/claude-haiku-4-5",
      thinking: "high",
      run_in_background: true,
    }, undefined, undefined, context);

    expect(textOf(resumed)).toContain("resumed in background");
    expect(resumeAgent).toHaveBeenCalledWith(
      session,
      "continue",
      expect.objectContaining({
        modelCandidates: [expect.objectContaining({ input: "anthropic/claude-haiku-4-5", thinking: "high" })],
      }),
    );
    await lifecycle.get("session_shutdown")?.();
  });
});
