import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  beginModelFallbackInvocation,
  getSessionModelCandidates,
  recordReopenedModelSelection,
  replaceSessionModelCandidates,
} from "../src/pi-retry-adapter.js";

function model(provider: string, id: string) {
  return {
    provider,
    id,
    name: id,
    api: "test",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  } as never;
}

function fakeSession(initialModel = model("one", "a")) {
  const failure = { role: "assistant" as const, stopReason: "error", errorMessage: "overloaded" };
  const state = {
    model: initialModel,
    thinkingLevel: "high",
    messages: [failure] as unknown[],
  };
  const appendModelChange = vi.fn();
  const appendThinkingLevelChange = vi.fn();
  const emitModelSelect = vi.fn(async () => {});
  const raw = {
    agent: { state },
    sessionManager: { appendModelChange, appendThinkingLevelChange, getBranch: vi.fn(() => []) },
    settingsManager: {},
    modelRuntime: {
      getModel: vi.fn((provider: string, id: string) => model(provider, id)),
      checkAuth: vi.fn(async () => ({ type: "api_key", key: "x" })),
    },
    get model() { return state.model; },
    get thinkingLevel() { return state.thinkingLevel; },
    _lastAssistantMessage: failure,
    _willRetryAfterAgentEnd: vi.fn(() => false),
    _isRetryableError: vi.fn(() => true),
    _emit: vi.fn(),
    _emitModelSelect: emitModelSelect,
    _handlePostAgentRun: vi.fn(async function(this: { _lastAssistantMessage?: unknown }) {
      this._lastAssistantMessage = undefined;
      return false;
    }),
  };
  return {
    session: raw as unknown as AgentSession,
    raw,
    failure,
    appendModelChange,
    appendThinkingLevelChange,
    emitModelSelect,
  };
}

describe("Pi retry adapter", () => {
  it("switches only after Pi leaves an exhausted retryable failure terminal", async () => {
    const { session, raw, appendModelChange } = fakeSession();
    const next = model("two", "b");
    const cleanup = beginModelFallbackInvocation(session, {
      candidates: [
        { input: "one/a", model: raw.agent.state.model },
        { input: "two/b", model: next },
      ],
      maxWraparounds: 0,
    });

    await expect(raw._handlePostAgentRun()).resolves.toBe(true);
    expect(raw.agent.state.messages).toEqual([]);
    expect(raw.agent.state.model).toMatchObject({ provider: "two", id: "b" });
    expect(appendModelChange).toHaveBeenCalledWith("two", "b");
    expect(getSessionModelCandidates(session)?.currentIndex).toBe(1);
    cleanup();
  });

  it("replaces a live resume selection without writing Pi defaults", async () => {
    const { session, raw, appendModelChange } = fakeSession();
    const next = model("two", "b");

    await replaceSessionModelCandidates(session, [{ input: "two/b", model: next }]);

    expect(raw.agent.state.model).toMatchObject({ provider: "two", id: "b" });
    expect(appendModelChange).toHaveBeenCalledWith("two", "b");
    expect(getSessionModelCandidates(session)).toMatchObject({ currentIndex: 0 });
  });

  it("records effective model and thinking entries when reopening persisted history", () => {
    const { session, appendModelChange, appendThinkingLevelChange } = fakeSession();
    recordReopenedModelSelection(session, {
      input: "one/a",
      model: session.model!,
      thinking: "high",
    });

    expect(appendModelChange).toHaveBeenCalledWith("one", "a");
    expect(appendThinkingLevelChange).toHaveBeenCalledWith("high");
  });

  it("does not switch after the runner's turn limit aborted the session", async () => {
    const { session, raw, failure } = fakeSession();
    beginModelFallbackInvocation(session, {
      candidates: [
        { input: "one/a", model: raw.agent.state.model },
        { input: "two/b", model: model("two", "b") },
      ],
      maxWraparounds: 0,
      canFallback: () => false,
    });

    await expect(raw._handlePostAgentRun()).resolves.toBe(false);
    expect(raw.agent.state.messages).toEqual([failure]);
    expect(raw.agent.state.model.provider).toBe("one");
  });

  it("skips a candidate removed from the live model catalog", async () => {
    const { session, raw } = fakeSession();
    raw.modelRuntime.getModel.mockImplementation((provider: string, id: string) =>
      provider === "two" ? undefined : model(provider, id));
    beginModelFallbackInvocation(session, {
      candidates: [
        { input: "one/a", model: raw.agent.state.model },
        { input: "two/b", model: model("two", "b") },
        { input: "three/c", model: model("three", "c") },
      ],
      maxWraparounds: 0,
    });

    await expect(raw._handlePostAgentRun()).resolves.toBe(true);
    expect(raw.agent.state.model).toMatchObject({ provider: "three", id: "c" });
  });

  it("does not switch when Pi removed the failure for its own retry", async () => {
    const { session, raw, failure } = fakeSession();
    raw._handlePostAgentRun = vi.fn(async function(this: { _lastAssistantMessage?: unknown }) {
      this._lastAssistantMessage = undefined;
      raw.agent.state.messages = [];
      return true;
    });
    beginModelFallbackInvocation(session, {
      candidates: [
        { input: "one/a", model: raw.agent.state.model },
        { input: "two/b", model: model("two", "b") },
      ],
      maxWraparounds: 0,
    });

    await expect(raw._handlePostAgentRun()).resolves.toBe(true);
    expect(raw.agent.state.model.provider).toBe("one");
    expect(raw.agent.state.messages).not.toContain(failure);
  });

  it("advances before a queue-only continuation and honors one wraparound", async () => {
    const { session, raw } = fakeSession();
    const first = raw.agent.state.model;
    const second = model("two", "b");
    raw._handlePostAgentRun = vi.fn(async function(this: { _lastAssistantMessage?: unknown }) {
      this._lastAssistantMessage = undefined;
      return true;
    });
    beginModelFallbackInvocation(session, {
      candidates: [
        { input: "one/a", model: first },
        { input: "two/b", model: second },
      ],
      maxWraparounds: 1,
    });

    for (const expected of [second, first, second]) {
      const failure = { role: "assistant" as const, stopReason: "error", errorMessage: "overloaded" };
      raw.agent.state.messages = [failure];
      raw._lastAssistantMessage = failure;
      await expect(raw._handlePostAgentRun()).resolves.toBe(true);
      expect(raw.agent.state.model).toMatchObject({ provider: expected.provider, id: expected.id });
    }

    const finalFailure = { role: "assistant" as const, stopReason: "error", errorMessage: "overloaded" };
    raw.agent.state.messages = [finalFailure];
    raw._lastAssistantMessage = finalFailure;
    await expect(raw._handlePostAgentRun()).resolves.toBe(true);
    expect(raw.agent.state.model).toMatchObject({ provider: second.provider, id: second.id });
    expect(raw.agent.state.messages).toEqual([finalFailure]);
  });
});
