import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import subagentsExtension, { restoredRecordFromSession } from "../src/index.js";
import { createOutputFilePath } from "../src/output-file.js";
import { resolveSubagentSessionDir } from "../src/session-dir.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parentRecords(records: Array<{ id: string; status: string; result?: string; error?: string; startedAt?: number }>): SessionEntry[] {
  const parent = SessionManager.inMemory("/work");
  for (const record of records) parent.appendCustomEntry("subagents:record", record);
  return parent.getEntries();
}

async function persistedChild(opts: {
  name: string;
  prompt?: string;
  invocation?: { agentId: string; startedAt: number };
  stopReason?: "stop" | "error";
}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-restore-"));
  dirs.push(dir);
  const parent = join(dir, "parent.jsonl");
  const child = SessionManager.create("/work", dir, { parentSession: parent });
  child.appendModelChange("openai", "gpt-test");
  child.appendThinkingLevelChange("high");
  child.appendSessionInfo(opts.name);
  const prompt = opts.prompt ?? "inspect the restored transcript";
  child.appendCustomEntry("subagents:task", { prompt });
  if (opts.invocation) child.appendCustomEntry("subagents:invocation", opts.invocation);
  child.appendMessage({ role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 } as never);
  child.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: opts.stopReason === "error" ? "" : "done" }],
    api: "test",
    provider: "openai",
    model: "gpt-test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: opts.stopReason ?? "stop",
    timestamp: 2,
  } as never);
  const info = (await SessionManager.list("/work", dir)).find(session => session.parentSessionPath === parent);
  expect(info).toBeDefined();
  return info!;
}

describe("persisted subagent session restore", () => {
  it("builds a completed record with a readable session from a persisted child session", async () => {
    const info = await persistedChild({ name: "explorer#abc12345" });
    const record = restoredRecordFromSession(info, "parent-session", parentRecords([
      { id: "abc12345-rest-of-id", status: "completed", result: "done" },
    ]));

    expect(record).toMatchObject({
      id: `restored-${info.id}`,
      type: "explorer",
      status: "completed",
      description: "inspect the restored transcript",
      taskPrompt: "inspect the restored transcript",
      result: "done",
      sessionFile: info.path,
      rootSessionId: "parent-session",
      restoredSession: true,
    });
    expect(record?.restoredInterrupted).toBeUndefined();
    expect(record?.session?.sessionManager?.getBranch().some(entry => entry.type === "custom" && entry.customType === "subagents:task")).toBe(true);
    expect(record?.session?.messages.at(-1)?.role).toBe("assistant");
  });

  it("treats a child with no parent terminal record as interrupted", async () => {
    const info = await persistedChild({ name: "explorer#abc12345" });
    const record = restoredRecordFromSession(info, "parent-session");

    expect(record).toMatchObject({
      status: "aborted",
      restoredSession: true,
      restoredInterrupted: true,
    });
  });

  it("uses transcript error status when an interrupted child ended in an assistant error", async () => {
    const info = await persistedChild({ name: "explorer#deadbeef", stopReason: "error" });
    const record = restoredRecordFromSession(info, "parent-session", []);

    expect(record).toMatchObject({
      status: "error",
      restoredSession: true,
      restoredInterrupted: true,
    });
  });

  it("preserves a matched terminal record's status over the child transcript", async () => {
    const info = await persistedChild({ name: "explorer#abc12345", stopReason: "error" });
    const record = restoredRecordFromSession(info, "parent-session", parentRecords([
      { id: "abc12345ffff", status: "steered" },
    ]));

    expect(record).toMatchObject({
      status: "steered",
      restoredSession: true,
    });
    expect(record?.restoredInterrupted).toBeUndefined();
  });

  it("matches a terminal record by the latest persisted invocation identity", async () => {
    const info = await persistedChild({
      name: "explorer#mismatch",
      invocation: { agentId: "full-agent-id-9999", startedAt: 100 },
    });
    const record = restoredRecordFromSession(info, "parent-session", parentRecords([
      { id: "full-agent-id-9999", status: "stopped", error: "user stop", startedAt: 100 },
    ]));

    expect(record).toMatchObject({
      status: "stopped",
      error: "user stop",
      startedAt: 100,
      restoredSession: true,
    });
    expect(record?.restoredInterrupted).toBeUndefined();
  });

  it("does not let an earlier completion mask an interrupted same-id resume", async () => {
    const info = await persistedChild({
      name: "explorer#same-id",
      invocation: { agentId: "same-id-full", startedAt: 200 },
    });
    const record = restoredRecordFromSession(info, "parent-session", parentRecords([
      { id: "same-id-full", status: "completed", result: "older run", startedAt: 100 },
    ]));

    expect(record).toMatchObject({
      status: "aborted",
      startedAt: 200,
      restoredSession: true,
      restoredInterrupted: true,
    });
    expect(record?.result).toBeUndefined();
  });

  it("uses a reopened session's latest invocation instead of its original identity", async () => {
    const info = await persistedChild({
      name: "explorer#new-id12",
      invocation: { agentId: "new-id12-full", startedAt: 300 },
    });
    const record = restoredRecordFromSession(info, "parent-session", parentRecords([
      { id: "original-id", status: "completed", result: "original run", startedAt: 100 },
    ]));

    expect(record).toMatchObject({
      status: "aborted",
      startedAt: 300,
      restoredInterrupted: true,
    });
    expect(record?.result).toBeUndefined();
  });

  it("restores transcript records without handles and keeps them through cleanup", async () => {
    const manager = new AgentManager();
    try {
      const restored = manager.restoreCompleted({
        id: "restored-old",
        type: "explorer",
        description: "old transcript",
        status: "completed",
        toolUses: 0,
        startedAt: 1,
        completedAt: 2,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
        sessionFile: "/tmp/old.jsonl",
        restoredSession: true,
      });

      (manager as unknown as { cleanup(): void }).cleanup();

      expect(restored.handle).toBeUndefined();
      expect(restored.alias).toBeUndefined();
      expect(manager.listAgents().map(agent => agent.id)).toContain("restored-old");
    } finally {
      await manager.dispose();
    }
  });

  it("keeps interrupted restored records in the manager without exposing handles", async () => {
    const manager = new AgentManager();
    try {
      const restored = manager.restoreCompleted({
        id: "restored-cut",
        type: "explorer",
        description: "cut short",
        status: "aborted",
        toolUses: 0,
        startedAt: 1,
        completedAt: 2,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        compactionCount: 0,
        sessionFile: "/tmp/cut.jsonl",
        restoredSession: true,
        restoredInterrupted: true,
      });

      expect(restored.handle).toBeUndefined();
      expect(restored.alias).toBeUndefined();
      expect(restored.status).toBe("aborted");
      expect(restored.restoredInterrupted).toBe(true);
      expect(manager.listAgents().map(agent => agent.id)).toContain("restored-cut");
    } finally {
      await manager.dispose();
    }
  });
});

/**
 * The session container the runner hands to SessionManager, exercised against
 * the real SessionManager and real files: a child that ran in a different cwd
 * (an isolated worktree) must still be discovered from its parent's context,
 * and its default artifacts must not land in the agent dir.
 */
describe("persisted subagent restore under the session-root override", () => {
  let root: string;
  let agentDir: string;
  let sessionRoot: string;
  let parentCwd: string;
  let worktreeCwd: string;
  let previousCwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-env-restore-"));
    agentDir = join(root, "agent");
    sessionRoot = join(root, "env-sessions");
    parentCwd = join(root, "parent-project");
    worktreeCwd = join(root, "worktree-copy");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(worktreeCwd, { recursive: true });
    mkdirSync(join(parentCwd, ".pi"), { recursive: true });
    writeFileSync(join(parentCwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, workflowsEnabled: false }));
    previousCwd = process.cwd();
    process.chdir(parentCwd);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", sessionRoot);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function persistedChild(opts: { dir: string; cwd: string; parentSession: string; agentId: string; task: string }) {
    const child = SessionManager.create(opts.cwd, opts.dir, { parentSession: opts.parentSession });
    child.appendModelChange("openai", "gpt-test");
    child.appendSessionInfo(`explorer#${opts.agentId.slice(0, 8)}`);
    child.appendCustomEntry("subagents:task", { prompt: opts.task });
    child.appendCustomEntry("subagents:invocation", { agentId: opts.agentId, startedAt: 1 });
    child.appendMessage({ role: "user", content: [{ type: "text", text: opts.task }], timestamp: 1 } as never);
    child.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "test",
      provider: "openai",
      model: "gpt-test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 2,
    } as never);
    return child;
  }

  /** Boot the real extension against a parent session and expose its tool registry. */
  function boot(sessionManager: SessionManager) {
    const tools = new Map<string, any>();
    const lifecycle = new Map<string, any>();
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn((customType: string, data: unknown) => { sessionManager.appendCustomEntry(customType, data); }),
      sendMessage: vi.fn(),
      getAllTools: () => [],
    } as any;
    subagentsExtension(pi);
    const ctx = {
      hasUI: false,
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
      cwd: parentCwd,
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager,
      getSystemPrompt: vi.fn(() => "parent"),
    } as any;
    return { tools, lifecycle, ctx };
  }

  it("discovers worktree children from the session container and keeps artifacts out of the agent dir", async () => {
    // The container the runner resolves for a persisted child.
    const container = resolveSubagentSessionDir()!;
    expect(container).toBe(join(sessionRoot, "subagents"));
    const parent = SessionManager.create(parentCwd, sessionRoot);
    const parentSession = parent.getSessionFile()!;
    parent.appendCustomEntry("subagents:record", { id: "child-agent-id", status: "completed", result: "RESTORED-RESULT", startedAt: 1 });
    parent.appendCustomEntry("subagents:record", { id: "legacy-agent-id", status: "completed", result: "LEGACY-RESULT", startedAt: 1 });
    parent.appendMessage({ role: "user", content: [{ type: "text", text: "parent turn" }], timestamp: 1 } as never);

    // New layout: the child of this parent, persisted in a different cwd.
    const child = persistedChild({ dir: container, cwd: worktreeCwd, parentSession, agentId: "child-agent-id", task: "child task" });
    // Legacy layout: a child persisted directly in the parent's session dir.
    const legacy = persistedChild({ dir: sessionRoot, cwd: parentCwd, parentSession, agentId: "legacy-agent-id", task: "legacy task" });
    // Another parent's child in the same container — must not be claimed.
    const stranger = persistedChild({
      dir: container,
      cwd: worktreeCwd,
      parentSession: join(sessionRoot, "other-parent.jsonl"),
      agentId: "stranger-id",
      task: "stranger task",
    });

    const childFile = child.getSessionFile()!;
    expect(childFile.startsWith(container)).toBe(true);
    expect(existsSync(childFile)).toBe(true);

    const { tools, lifecycle, ctx } = boot(parent);

    await lifecycle.get("session_start")?.({}, ctx);

    const read = tools.get("get_subagent_result");
    const childInfo = (await SessionManager.listAll(container)).find(info => info.path === childFile)!;
    const restoredChild = await read.execute("tc-1", { agent_id: `restored-${childInfo.id}` }, undefined, undefined, ctx);
    expect(restoredChild.content[0].text).toContain("RESTORED-RESULT");

    const legacyInfo = (await SessionManager.listAll(sessionRoot)).find(info => info.path === legacy.getSessionFile())!;
    const restoredLegacy = await read.execute("tc-2", { agent_id: `restored-${legacyInfo.id}` }, undefined, undefined, ctx);
    expect(restoredLegacy.content[0].text).toContain("LEGACY-RESULT");

    const strangerInfo = (await SessionManager.listAll(container)).find(info => info.path === stranger.getSessionFile())!;
    const restoredStranger = await read.execute("tc-3", { agent_id: `restored-${strangerInfo.id}` }, undefined, undefined, ctx);
    expect(restoredStranger.content[0].text).toContain("Agent not found");

    // Default artifacts follow the same container, not the agent dir.
    const binding = parent.getEntries().find(entry => entry.type === "custom" && entry.customType === "subagents:artifacts")!;
    expect((binding as { data?: { artifactRoot?: string } }).data?.artifactRoot?.startsWith(container)).toBe(true);
    expect(createOutputFilePath(parentCwd, "agent-1", "session-1").startsWith(container)).toBe(true);
    expect(existsSync(join(agentDir, "sessions"))).toBe(false);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("lists the child container once when it is also the parent's session directory", async () => {
    const container = join(sessionRoot, "subagents");
    // A parent whose session dir IS the container: the helper and
    // getSessionDir() resolve to the same path, so it must be read once.
    const parent = SessionManager.create(parentCwd, container);
    const parentSession = parent.getSessionFile()!;
    parent.appendCustomEntry("subagents:record", { id: "child-agent-id", status: "completed", result: "RESTORED-ONCE", startedAt: 1 });
    const child = persistedChild({ dir: container, cwd: worktreeCwd, parentSession, agentId: "child-agent-id", task: "child task" });

    const { tools, lifecycle, ctx } = boot(parent);
    const listAll = vi.spyOn(SessionManager, "listAll");
    try {
      await lifecycle.get("session_start")?.({}, ctx);
      expect(listAll).toHaveBeenCalledTimes(1);
    } finally {
      listAll.mockRestore();
    }

    const childInfo = (await SessionManager.listAll(container)).find(info => info.path === child.getSessionFile())!;
    const restored = await tools.get("get_subagent_result").execute("tc-1", { agent_id: `restored-${childInfo.id}` }, undefined, undefined, ctx);
    expect(restored.content[0].text).toContain("RESTORED-ONCE");

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
