/**
 * wait-queued.test.ts — get_subagent_result(wait: true) lifecycle behavior.
 *
 * Queued records have no promise yet (it's created when the queue starts
 * them), so the old `status === "running" && record.promise` condition
 * skipped the wait entirely and returned "still running" — forcing the
 * caller into a poll loop against the concurrency queue.
 *
 * Wiring test through the REAL extension: spawn background agents until one
 * queues, call the real tool with wait:true, drain the queue, and assert the
 * call returns the final result.
 *
 * Also covers the wait's other release path: pi holds anything the operator types
 * until the tool returns, so a wait that ignores queued input strands a prompt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { waitForResult } from "../src/result-wait.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx(hasPendingMessages: () => boolean = () => false) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    hasPendingMessages: vi.fn(hasPendingMessages),
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

// A hanging fake-timer test never reaches its own finally, and leaked fake
// timers would time out every later test in this file.
afterEach(() => { vi.useRealTimers(); });

/** runAgent mock where each call blocks until we resolve it manually. */
function deferredRuns() {
  const resolvers: Array<(v: any) => void> = [];
  vi.mocked(runAgent).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(() =>
          resolve({
            responseText: "THE-RESULT-PAYLOAD",
            session: { dispose: vi.fn() } as any,
            aborted: false,
            steered: false,
          }),
        );
      }) as any,
  );
  return resolvers;
}

/** Single blocking run; `resolveRun` settles it, `childSignal` is its abort signal. */
function onePendingRun() {
  const run: { resolveRun?: () => void; childSignal?: AbortSignal } = {};
  vi.mocked(runAgent).mockImplementation(
    (_ctx, _type, _prompt, options) =>
      new Promise((resolve) => {
        run.childSignal = options.signal;
        run.resolveRun = () => resolve({
          responseText: "THE-RESULT-PAYLOAD",
          session: { dispose: vi.fn() } as any,
          aborted: false,
          steered: false,
        });
      }),
  );
  return run;
}

async function spawnBackground(tools: Map<string, any>): Promise<{ id: string; queued: boolean }> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "queued-wait test agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(r))![1];
  return { id, queued: textOf(r).includes("queued in background") };
}

describe("get_subagent_result wait:true on a queued agent", () => {
  it("waits through queue start and returns the result (no 'still running')", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();

    // Spawn until one lands in the queue (concurrency limit is config-dependent).
    let queuedId: string | undefined;
    for (let i = 0; i < 20 && !queuedId; i++) {
      const { id, queued } = await spawnBackground(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 20 spawns").toBeDefined();

    // wait:true on the QUEUED agent — must not return "still running".
    const waitPromise = tools
      .get("get_subagent_result")
      .execute("tc-wait", { agent_id: queuedId, wait: true }, undefined, undefined, ctx());

    // Drain: resolve running agents until the queued one starts and finishes.
    let settled = false;
    void waitPromise.then(() => { settled = true; });
    for (let i = 0; i < 40 && !settled; i++) {
      while (resolvers.length > 0) resolvers.shift()!();
      await flush();
      await new Promise((r) => setTimeout(r, 100)); // outlive one 250ms poll tick
    }

    const result = await waitPromise;
    expect(textOf(result)).toContain("THE-RESULT-PAYLOAD");
    expect(textOf(result)).not.toContain("still running");

    await new Promise((r) => setTimeout(r, 350));
    expect(JSON.stringify(pi.sendMessage.mock.calls)).not.toContain(queuedId);

    await lifecycle.get("session_shutdown")?.();
  }, 20_000);

  it("aborts a running result wait without aborting or consuming the child", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    let resolveRun: (() => void) | undefined;
    let childSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation(
      (_ctx, _type, _prompt, options) =>
        new Promise((resolve) => {
          childSignal = options.signal;
          resolveRun = () => resolve({
            responseText: "THE-RESULT-PAYLOAD",
            session: { dispose: vi.fn() } as any,
            aborted: false,
            steered: false,
          });
        }),
    );

    const { id } = await spawnBackground(tools);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waitOutcome = tools
      .get("get_subagent_result")
      .execute("tc-wait-abort", { agent_id: id, wait: true }, controller.signal, undefined, ctx())
      .then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.name : String(error),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
    const childWasAborted = childSignal?.aborted;

    resolveRun?.();
    await flush();
    await waitOutcome;
    await new Promise((r) => setTimeout(r, 350));

    const completedResult = await tools
      .get("get_subagent_result")
      .execute("tc-result", { agent_id: id }, undefined, undefined, ctx());

    await lifecycle.get("session_shutdown")?.();

    expect(outcome).toBe("AbortError");
    expect(childWasAborted).toBe(false);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");
  });

  it("aborts a queued result wait before the agent starts", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    let queuedId: string | undefined;
    for (let i = 0; i < 20 && !queuedId; i++) {
      const { id, queued } = await spawnBackground(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 20 spawns").toBeDefined();

    const controller = new AbortController();
    const waitOutcome = tools
      .get("get_subagent_result")
      .execute("tc-queued-abort", { agent_id: queuedId, wait: true }, controller.signal, undefined, ctx())
      .then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.name : String(error),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    let completedResult: any;
    for (let i = 0; i < 40 && !completedResult; i++) {
      while (resolvers.length > 0) resolvers.shift()!();
      await flush();
      const result = await tools
        .get("get_subagent_result")
        .execute("tc-queued-result", { agent_id: queuedId }, undefined, undefined, ctx());
      if (textOf(result).includes("THE-RESULT-PAYLOAD")) completedResult = result;
      await new Promise((r) => setTimeout(r, 25));
    }

    await waitOutcome;
    await lifecycle.get("session_shutdown")?.();

    expect(outcome).toBe("AbortError");
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");
  });
});

describe("get_subagent_result wait:true releases on queued user input", () => {
  it("returns normally when input is already waiting, and leaves the run untouched", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const run = onePendingRun();
    const { id } = await spawnBackground(tools);

    const result = await tools
      .get("get_subagent_result")
      .execute("tc-typed-first", { agent_id: id, wait: true }, undefined, undefined, ctx(() => true));
    const childAbortedAfterReturn = run.childSignal?.aborted;

    // The agent runs on: not stopped, not consumed, so its notification still fires.
    run.resolveRun?.();
    await flush();
    await new Promise((r) => setTimeout(r, 350));
    const notified = JSON.stringify(pi.sendMessage.mock.calls);

    const collected = await tools
      .get("get_subagent_result")
      .execute("tc-collect", { agent_id: id }, undefined, undefined, ctx(() => true));

    await lifecycle.get("session_shutdown")?.();

    expect(textOf(result)).toContain("Wait interrupted by queued user input");
    expect(textOf(result)).toContain(id);
    expect(textOf(result)).toContain("still running");
    expect(textOf(result)).not.toContain("Agent is still running. Use wait: true");
    expect(childAbortedAfterReturn).toBe(false);
    expect(notified).toContain(id);
    expect(textOf(collected)).toContain("THE-RESULT-PAYLOAD");
  });

  it("releases a wait that is already running when input arrives", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const run = onePendingRun();
    const { id } = await spawnBackground(tools);
    const typed = { value: false };

    const waitPromise = tools
      .get("get_subagent_result")
      .execute("tc-typed-mid", { agent_id: id, wait: true }, undefined, undefined, ctx(() => typed.value));
    setTimeout(() => { typed.value = true; }, 120);

    const result = await Promise.race([
      waitPromise,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]);
    const childAbortedAfterReturn = run.childSignal?.aborted;
    await lifecycle.get("session_shutdown")?.();

    expect(result).toBeDefined();
    expect(textOf(result as any)).toContain("Wait interrupted by queued user input");
    expect(childAbortedAfterReturn).toBe(false);
  });

  it("releases a queued agent's wait without starting it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    let queuedId: string | undefined;
    for (let i = 0; i < 20 && !queuedId; i++) {
      const { id, queued } = await spawnBackground(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 20 spawns").toBeDefined();

    const typed = { value: false };
    const startedBeforeWait = resolvers.length;
    const waitPromise = tools
      .get("get_subagent_result")
      .execute("tc-queued-typed", { agent_id: queuedId, wait: true }, undefined, undefined, ctx(() => typed.value));
    setTimeout(() => { typed.value = true; }, 120);

    const result = await Promise.race([
      waitPromise,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]);
    const startedAfterWait = resolvers.length;

    while (resolvers.length > 0) resolvers.shift()!();
    await flush();
    await new Promise((r) => setTimeout(r, 350));
    await lifecycle.get("session_shutdown")?.();

    expect(textOf(result as any)).toContain("Wait interrupted by queued user input");
    expect(textOf(result as any)).toContain(queuedId!);
    expect(textOf(result as any)).toContain("still queued");
    // Releasing the wait did not pull the agent out of the queue.
    expect(startedAfterWait).toBe(startedBeforeWait);
  });

  it("wakes every active wait on the same input, independently", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    deferredRuns();
    const first = await spawnBackground(tools);
    const second = await spawnBackground(tools);
    const typed = { value: false };
    const reader = () => typed.value;

    const waits = Promise.all([
      tools.get("get_subagent_result").execute("tc-w1", { agent_id: first.id, wait: true }, undefined, undefined, ctx(reader)),
      tools.get("get_subagent_result").execute("tc-w2", { agent_id: second.id, wait: true }, undefined, undefined, ctx(reader)),
    ]);
    setTimeout(() => { typed.value = true; }, 120);

    const results = await Promise.race([
      waits,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]);
    await lifecycle.get("session_shutdown")?.();

    expect(results).toBeDefined();
    for (const result of results as any[]) {
      expect(textOf(result)).toContain("Wait interrupted by queued user input");
      expect(textOf(result)).toContain("keeps running in the background");
    }
  });

  it("leaves wait:false alone even with input waiting", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    onePendingRun();
    const { id } = await spawnBackground(tools);

    const result = await tools
      .get("get_subagent_result")
      .execute("tc-nowait", { agent_id: id }, undefined, undefined, ctx(() => true));
    await lifecycle.get("session_shutdown")?.();

    expect(textOf(result)).not.toContain("Wait interrupted by queued user input");
    expect(textOf(result)).toContain("Agent is still running. Use wait: true or check back later.");
  });

  it("reads pending input before arming the poll, so an already-waiting queue releases at once", async () => {
    // Under fake timers the 50ms tick never fires, so only an up-front read can
    // release this wait — a poll-only implementation hangs instead.
    vi.useFakeTimers();
    let outcome: string | undefined;
    try {
      outcome = await waitForResult({ status: "running", promise: new Promise(() => {}) }, () => true);
    } finally {
      vi.useRealTimers();
    }

    expect(outcome).toBe("pending-input");
  });

  it("releases on input without leaving an abort listener or a poll behind", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const typed = { value: false };
    let outcome: string | undefined;
    let timersAfterRelease: number | undefined;
    try {
      const wait = waitForResult(
        { status: "running", promise: new Promise(() => {}) },
        () => typed.value,
        controller.signal,
      );
      typed.value = true;
      vi.advanceTimersByTime(60);
      outcome = await wait;
      timersAfterRelease = vi.getTimerCount();
    } finally {
      vi.useRealTimers();
    }

    expect(outcome).toBe("pending-input");
    expect(timersAfterRelease).toBe(0);
    expect(addListener.mock.calls.map(([type]) => type)).toEqual(["abort"]);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener.mock.calls[0]?.[0]).toBe("abort");
  });

  it("absorbs a child rejection that lands after the wait released", async () => {
    const record = { status: "running", promise: undefined as Promise<unknown> | undefined };
    let rejectRun!: (error: Error) => void;
    record.promise = new Promise((_resolve, reject) => { rejectRun = reject; });
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", collect);

    let outcome: string | undefined;
    try {
      outcome = await waitForResult(record, () => true);
      rejectRun(new Error("child blew up"));
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", collect);
    }

    expect(outcome).toBe("pending-input");
    expect(unhandled).toEqual([]);
  });
});
