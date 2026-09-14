import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { restoredRecordFromSession } from "../src/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persisted subagent session restore", () => {
  it("builds a completed record with a readable session from a persisted child session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagents-restore-"));
    dirs.push(dir);
    const parent = join(dir, "parent.jsonl");
    const child = SessionManager.create("/work", dir, { parentSession: parent });
    child.appendModelChange("openai", "gpt-test");
    child.appendThinkingLevelChange("high");
    child.appendSessionInfo("explorer#abc12345");
    child.appendCustomEntry("subagents:task", { prompt: "inspect the restored transcript" });
    child.appendMessage({ role: "user", content: [{ type: "text", text: "inspect the restored transcript" }], timestamp: 1 } as never);
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

    const info = (await SessionManager.list("/work", dir)).find(session => session.parentSessionPath === parent);
    expect(info).toBeDefined();

    const record = restoredRecordFromSession(info!, "parent-session");

    expect(record).toMatchObject({
      id: `restored-${info!.id}`,
      type: "explorer",
      status: "completed",
      description: "inspect the restored transcript",
      taskPrompt: "inspect the restored transcript",
      sessionFile: info!.path,
      rootSessionId: "parent-session",
      restoredSession: true,
    });
    expect(record?.session?.sessionManager?.getBranch().some(entry => entry.type === "custom" && entry.customType === "subagents:task")).toBe(true);
    expect(record?.session?.messages.at(-1)?.role).toBe("assistant");
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
});
