import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { beginModelFallbackInvocation } from "../../src/pi-retry-adapter.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("model fallback through a real Pi AgentSession", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("uses Pi's retry once, then changes model and continues without replaying the prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-fallback-e2e-"));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const faux = registerFauxProvider({
      provider: "fallback-faux",
      models: [{ id: "first" }, { id: "second" }],
    });
    cleanups.push(faux.unregister);
    const first = faux.getModel("first");
    const second = faux.getModel("second");
    if (!first || !second) throw new Error("faux models were not registered");

    type ResponseStep = Parameters<typeof faux.setResponses>[0][number];
    type ResponseFactory = Extract<ResponseStep, (...args: never[]) => unknown>;
    const failed: ResponseFactory = (_context, _options, _state, selected) => ({
      role: "assistant",
      content: [],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      usage: ZERO_USAGE,
      stopReason: "error",
      errorMessage: "529 overloaded",
      timestamp: Date.now(),
    });
    const succeeded: ResponseFactory = (_context, _options, _state, selected) => ({
      role: "assistant",
      content: [{ type: "text", text: "RECOVERED" }],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    });
    faux.setResponses([failed, failed, succeeded]);

    const backend = fauxModelBackend(first);
    const models = [first, second];
    const modelRegistry = {
      ...backend.modelRegistry,
      find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
      getAll: () => models,
      getAvailable: () => models,
    };
    const modelRuntime = {
      ...backend.modelRuntime,
      getModel: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
      getModels: () => models,
      getAvailable: async () => models,
      getAvailableSnapshot: () => models,
    };
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    });
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      model: first,
      modelRegistry,
      modelRuntime,
      tools: [],
    } as never);
    const transitions: string[] = [];
    const end = beginModelFallbackInvocation(session, {
      candidates: [
        { input: `${first.provider}/${first.id}`, model: first },
        { input: `${second.provider}/${second.id}`, model: second },
      ],
      maxWraparounds: 0,
      onTransition: transition => transitions.push(transition.candidate.model.id),
    });

    try {
      await session.prompt("do the work");
      expect(faux.state.callCount).toBe(3);
      expect(transitions).toEqual(["second"]);
      expect(session.model?.id).toBe("second");
      expect(settingsManager.getDefaultProvider()).toBeUndefined();
      expect(settingsManager.getDefaultModel()).toBeUndefined();
      expect(settingsManager.getDefaultThinkingLevel()).toBeUndefined();
      expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
      const last = session.messages.at(-1);
      expect(last?.role).toBe("assistant");
      expect(last?.role === "assistant" ? last.content : []).toContainEqual({ type: "text", text: "RECOVERED" });
    } finally {
      end();
      await session.dispose();
    }
  });
});
