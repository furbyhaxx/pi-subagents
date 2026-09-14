import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, releaseWorktreeLease, resumeWorktree, type WorktreeInfo } from "../src/worktree.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  resumeWorktree: vi.fn(),
  releaseWorktreeLease: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
  pruneWorktrees: vi.fn(),
}));

const scope: WorktreeInfo = {
  lifecycle: "retained", path: "/worktrees/feature", branch: "feat/x",
  workPath: "/worktrees/feature/packages/api", sourceRoot: "/repo", commonDir: "/repo/.git",
  baseSha: "abc", reused: true, initialDirty: true,
};
const pi = {} as ExtensionAPI;
const ctx = { cwd: "/repo/packages/api" } as ExtensionContext;
const spawnOptions = { description: "feature", branch: "feat/x", artifactRoot: "/artifacts/session" };
let manager: AgentManager;
let session: AgentSession;

beforeEach(() => {
  vi.clearAllMocks();
  registerAgents(new Map());
  manager = new AgentManager();
  session = {
    dispose: vi.fn(),
    sessionManager: { getSessionFile: () => "/sessions/child.jsonl", appendCustomEntry: vi.fn() },
  } as unknown as AgentSession;
  vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
  vi.mocked(createWorktree).mockResolvedValue({ ...scope });
  vi.mocked(resumeWorktree).mockResolvedValue();
  vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "feat/x", path: scope.path, retained: true });
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(session);
    return { responseText: "done", structuredJson: '{"ok":true}', session, aborted: false, steered: false };
  });
  vi.mocked(resumeAgent).mockResolvedValue({ text: "continued" });
});
afterEach(async () => { await manager.dispose(); });

describe("branch-scoped manager execution", () => {
  it("runs in the scoped subdirectory with originating config and persists authoritative scope", async () => {
    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", "implement", spawnOptions);
    expect(createWorktree).toHaveBeenCalledWith(pi, ctx.cwd, record.id, expect.objectContaining({ branch: "feat/x", sessionRoot: "/artifacts/session" }));
    expect(runAgent).toHaveBeenCalledWith(ctx, "general-purpose", "implement", expect.objectContaining({ cwd: scope.workPath, configCwd: ctx.cwd, worktree: scope }));
    expect(session.sessionManager.appendCustomEntry).toHaveBeenCalledWith("subagents:workspace", expect.objectContaining({ worktree: scope, effectiveCwd: scope.workPath, artifactRoot: "/artifacts/session" }));
    expect(record.result).toContain("Workspace retained");
    expect(record.result).not.toContain("git merge");
    expect(JSON.parse(record.structuredJson!)).toEqual({ ok: true });
  });

  it("holds scope through the effective-cwd gate and refuses reentry during settlement", async () => {
    let finishGate!: () => void;
    let enteredGate!: () => void;
    const entered = new Promise<void>(resolve => { enteredGate = resolve; });
    const gate = new Promise<void>(resolve => { finishGate = resolve; });
    const id = manager.spawn(pi, ctx, "general-purpose", "implement", {
      ...spawnOptions,
      onBeforeWorktreeCleanup: async cwd => {
        expect(cwd).toBe(scope.workPath);
        enteredGate();
        await gate;
      },
    });
    await entered;
    expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(await manager.resume(id, "race")).toBeUndefined();
    finishGate();
    await manager.getRecord(id)!.promise;
    expect(cleanupWorktree).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reacquires on resume and refuses a missing workspace (background=%s)", async isBackground => {
    const { id, record } = await manager.spawnAndWait(pi, ctx, "general-purpose", "implement", spawnOptions);
    await manager.resume(id, "continue", undefined, { isBackground });
    await record.promise;
    expect(resumeWorktree).toHaveBeenCalledWith(pi, record.worktree, id);
    expect(resumeAgent).toHaveBeenCalledWith(session, "continue", expect.objectContaining({ worktree: scope, cwd: scope.workPath }));
    expect(releaseWorktreeLease).toHaveBeenCalledWith(record.worktree);
    vi.mocked(resumeAgent).mockClear();
    vi.mocked(resumeWorktree).mockRejectedValueOnce(new Error("Worktree missing"));
    await manager.resume(id, "continue again", undefined, { isBackground });
    await record.promise;
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(record.status).toBe("error");
    expect(record.error).toContain("Worktree missing");
  });

  it("preserves worktree and storage scope in an evicted conversation", async () => {
    const { id } = await manager.spawnAndWait(pi, ctx, "general-purpose", "implement", spawnOptions);
    manager.getRecord(id)!.completedAt = 0;
    // Invoke the timer's operation without waiting ten minutes.
    const cleanup = Reflect.get(manager, "cleanup") as () => void;
    cleanup.call(manager);
    expect(manager.resolveMention("general-purpose")).toEqual({ kind: "tombstone", entry: expect.objectContaining({ worktree: scope, effectiveCwd: scope.workPath, configCwd: ctx.cwd, artifactRoot: "/artifacts/session" }) });
  });

  it("honors anonymous worktree defaults and vetoes on programmatic spawns", async () => {
    const config = getAgentConfig("general-purpose")!;
    registerAgents(new Map([[config.name, { ...config, isolation: "off" }]]));
    await manager.spawnAndWait(pi, ctx, config.name, "run", { description: "run", isolation: "worktree" });
    expect(createWorktree).not.toHaveBeenCalled();
    registerAgents(new Map([[config.name, { ...config, isolation: "worktree" }]]));
    await manager.spawnAndWait(pi, ctx, config.name, "run", { description: "run", artifactRoot: "/artifacts/session" });
    expect(createWorktree).toHaveBeenCalledOnce();
  });

  it("cleans up a workspace if a startup lifecycle subscriber throws", async () => {
    await manager.dispose();
    manager = new AgentManager(undefined, undefined, () => { throw new Error("subscriber failed"); });
    await expect(manager.spawnAndWait(pi, ctx, "general-purpose", "implement", spawnOptions)).rejects.toThrow(/subscriber failed.*Workspace retained/);
    expect(cleanupWorktree).toHaveBeenCalledOnce();
    expect(runAgent).not.toHaveBeenCalled();
    expect(releaseWorktreeLease).toHaveBeenCalledWith(scope);
  });

  it("rejects off conflicts below all tool schemas and releases failed acquisition's pool slot", async () => {
    expect(() => manager.spawn(pi, ctx, "general-purpose", "implement", { ...spawnOptions, isolation: "off" })).toThrow(/off/);
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(false);
    expect(() => manager.spawn(pi, ctx, "general-purpose", "implement", spawnOptions)).toThrow(/disabled/);
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
    manager.setMaxConcurrent(1);
    vi.mocked(createWorktree).mockRejectedValueOnce(new Error("branch busy"));
    const failed = manager.spawn(pi, ctx, "general-purpose", "implement", { ...spawnOptions, isBackground: true });
    const next = manager.spawn(pi, ctx, "general-purpose", "other", { description: "next", isBackground: true });
    await expect(manager.awaitStartup(failed)).rejects.toThrow("branch busy");
    await manager.waitForAll();
    expect(manager.getRecord(next)?.status).toBe("completed");
  });
});
