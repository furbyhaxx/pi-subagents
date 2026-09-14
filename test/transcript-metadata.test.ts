import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

const pi = {} as ExtensionAPI;
const ctx = {
  cwd: "/repo",
  sessionManager: { getSessionId: () => "root-session" },
} as ExtensionContext;

function createSession(sessionManager: object): AgentSession {
  return { dispose: vi.fn(), sessionManager } as unknown as AgentSession;
}

describe("transcript task metadata", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.resetAllMocks();
    manager = new AgentManager();
  });

  afterEach(async () => {
    await manager.dispose();
  });

  it("captures and persists the exact fresh assignment without sending an LLM message", async () => {
    const appendCustomEntry = vi.fn();
    const appendCustomMessageEntry = vi.fn();
    const session = createSession({
      getSessionFile: () => "/sessions/fresh.jsonl",
      appendCustomEntry,
      appendCustomMessageEntry,
    });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });

    const prompt = "  Inspect the auth flow.\nKeep exact wording.  ";
    const id = manager.spawn(pi, ctx, "Explore", prompt, {
      description: "Inspect auth flow",
      inheritContext: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.taskPrompt).toBe(prompt);
    expect(runAgent).toHaveBeenCalledWith(ctx, "Explore", prompt, expect.objectContaining({ inheritContext: true }));
    expect(appendCustomEntry).toHaveBeenCalledTimes(1);
    expect(appendCustomEntry).toHaveBeenCalledWith("subagents:task", { prompt });
    expect(appendCustomMessageEntry).not.toHaveBeenCalled();

    vi.mocked(resumeAgent).mockResolvedValue({ text: "continued" });
    await manager.resume(id, "A later continuation prompt");
    expect(record.taskPrompt).toBe(prompt);
    expect(appendCustomEntry).toHaveBeenCalledTimes(1);
  });

  it("hydrates the original task from the active resumed branch without overwriting it", async () => {
    const appendCustomEntry = vi.fn();
    const originalPrompt = "Original persisted assignment";
    const getBranch = vi.fn(() => [
      { type: "custom", customType: "unrelated", data: { value: true } },
      { type: "custom", customType: "subagents:task", data: { prompt: originalPrompt } },
    ]);
    const session = createSession({
      getSessionFile: () => "/sessions/resumed.jsonl",
      getBranch,
      appendCustomEntry,
    });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });

    const resumePrompt = "Continue with a different request";
    const id = manager.spawn(pi, ctx, "Explore", resumePrompt, {
      description: "Continue exploration",
      resumeSessionFile: "/sessions/resumed.jsonl",
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(getBranch).toHaveBeenCalledOnce();
    expect(record.taskPrompt).toBe(originalPrompt);
    expect(record.taskPrompt).not.toBe(resumePrompt);
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("leaves task metadata absent when an older resumed branch has no task entry", async () => {
    const getBranch = vi.fn(() => [{ type: "custom", customType: "unrelated", data: {} }]);
    const session = createSession({ getSessionFile: () => "/sessions/older.jsonl", getBranch });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });

    const id = manager.spawn(pi, ctx, "Explore", "Continuation for older session", {
      description: "Continue exploration",
      resumeSessionFile: "/sessions/older.jsonl",
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(getBranch).toHaveBeenCalledOnce();
    expect(record.taskPrompt).toBeUndefined();
  });

  it("degrades when a resumed-session stub has no branch reader", async () => {
    const session = createSession({ getSessionFile: () => "/sessions/partial.jsonl" });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });

    const id = manager.spawn(pi, ctx, "Explore", "Continuation for partial session", {
      description: "Continue exploration",
      resumeSessionFile: "/sessions/partial.jsonl",
    });
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.taskPrompt).toBeUndefined();
  });
});
