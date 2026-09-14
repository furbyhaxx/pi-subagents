import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { restoredRecordFromSession } from "../src/index.js";

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
