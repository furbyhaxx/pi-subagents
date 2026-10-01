/**
 * Continuing a restored worktree agent's conversation.
 *
 * A record the session-start scan rebuilt is transcript-only, so continuing it
 * is a reopen: a fresh agent over the same session file, with the recorded
 * worktree reacquired — the call `reopenTombstone` makes in index.ts, driven
 * here against the manager so the git worktree contract stays under test
 * without a model. Resuming the restored record in place is refused
 * (session-restore.test.ts), which is why nothing below prompts its stand-in.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { restoredRecordFromSession } from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { cleanupWorktree, createWorktree, type WorktreeInfo } from "../src/worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function mockPi(onCommand?: (args: string[], cwd: string | undefined) => void): ExtensionAPI {
  return {
    getAllTools: () => [],
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      onCommand?.(args, options?.cwd);
      try {
        const stdout = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; status?: number };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          code: failure.status ?? 1,
          killed: false,
        };
      }
    },
  } as unknown as ExtensionAPI;
}

let root: string;
let repo: string;
let sessions: string;
let scope: WorktreeInfo;
let api: ExtensionAPI;
let manager: AgentManager;
let ctx: ExtensionContext;
let leaseObserved = false;
let watchLease = false;

function jobsBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const stoppedPaths: string[] = [];
  const bus = {
    on(channel: string, handler: (data: unknown) => void) {
      const listeners = handlers.get(channel) ?? new Set();
      listeners.add(handler);
      handlers.set(channel, listeners);
      return () => { listeners.delete(handler); };
    },
    emit(channel: string, data: unknown) {
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
      if (!data || typeof data !== "object") return;
      const request = data as { requestId?: unknown; path?: unknown };
      if (typeof request.requestId !== "string") return;
      if (channel === "background-jobs:rpc:ping") {
        bus.emit(`${channel}:reply:${request.requestId}`, { success: true, data: { version: 1 } });
      } else if (channel === "background-jobs:rpc:stop-worktree" && typeof request.path === "string") {
        stoppedPaths.push(request.path);
        bus.emit(`${channel}:reply:${request.requestId}`, { success: true, data: { stopped: [] } });
      }
    },
    stoppedPaths,
  };
  return bus;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-wt-resume-"));
  repo = join(root, "repo");
  sessions = join(root, "sessions");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  api = mockPi((args, cwd) => {
    if (!watchLease || args[0] !== "status" || cwd !== scope?.path) return;
    const leaseDir = join(scope.commonDir, "pi-subagents-leases");
    leaseObserved ||= readdirSync(leaseDir).some(name => name.endsWith(".lock"));
  });
  scope = (await createWorktree(api, repo, "restored-agent", { branch: "pi/restored-agent", sessionRoot: sessions }))!;
  scope.named = false;
  await cleanupWorktree(api, repo, scope, "initial run", "restored-agent");
  manager = new AgentManager();
  manager.setDefaultApi(api);
  leaseObserved = false;
  ctx = { cwd: repo, modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) }, getSystemPrompt: vi.fn(() => "parent") } as unknown as ExtensionContext;
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockResolvedValue({ responseText: "continued" } as never);
});

/** The reopen `reopenTombstone` performs for a restored record, plus the rebind. */
async function reopen(record: AgentRecord, prompt: string, pi: ExtensionAPI = api) {
  const id = manager.spawn(pi, ctx, record.type, prompt, {
    description: record.description,
    resumeSessionFile: record.sessionFile,
    resumeWorktree: record.worktree,
    cwd: record.effectiveCwd,
    configCwd: record.configCwd,
    isBackground: true,
  });
  await manager.awaitStartup(id);
  manager.getRecord(id)!.originalId = record.originalId ?? record.id;
  return id;
}

afterEach(async () => {
  watchLease = false;
  await manager.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function restoredRecord(worktree: WorktreeInfo) {
  const parent = SessionManager.create(repo, sessions);
  const parentSession = parent.getSessionFile();
  if (!parentSession) throw new Error("Missing parent session file");
  const agentId = "restored-worktree-agent";
  const startedAt = Date.now();
  parent.appendCustomEntry("subagents:record", { id: agentId, status: "stopped", startedAt });
  const child = SessionManager.create(worktree.workPath, sessions, { parentSession });
  child.appendSessionInfo("general-purpose#restore");
  child.appendCustomEntry("subagents:task", { prompt: "continue the work" });
  child.appendCustomEntry("subagents:invocation", { agentId, startedAt });
  child.appendCustomEntry("subagents:workspace", { worktree });
  child.appendMessage({ role: "user", content: "continue the work", timestamp: startedAt } as never);
  child.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "paused" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: startedAt + 1,
  } as never);
  const info = (await SessionManager.listAll(sessions)).find(session => session.path === child.getSessionFile());
  if (!info) throw new Error("Missing persisted child session");
  const record = restoredRecordFromSession(info, parent.getSessionId() ?? "parent", parent.getEntries() as SessionEntry[]);
  if (!record) throw new Error("Could not restore child session");
  return record;
}

describe("resuming restored worktree agents", () => {
  it("uses the manager API after restart and reacquires the worktree lease", async () => {
    const record = manager.restoreCompleted(await restoredRecord(scope));
    const events = jobsBus();
    const jobsTools = ["bash", "job_list", "job_output", "job_stop"].map(name => ({
      name,
      sourceInfo: { path: "/tmp/background-jobs.js", source: "extension" },
    }));
    const jobsApi = { ...api, getAllTools: () => jobsTools, events } as unknown as ExtensionAPI;
    manager.setDefaultApi(jobsApi);
    watchLease = true;

    const id = await reopen(record, "continue", jobsApi);
    const reopened = manager.getRecord(id)!;
    await reopened.promise;

    expect(reopened.status).toBe("completed");
    expect(reopened.worktreeResult).toMatchObject({ hasChanges: false, branch: scope.branch, path: scope.path, retained: true });
    expect(events.stoppedPaths).toEqual([scope.path]);
    expect(leaseObserved).toBe(true);
    expect(readdirSync(join(scope.commonDir, "pi-subagents-leases")).some(name => name.endsWith(".lock"))).toBe(false);
  });

  it.each(["missing", "changed"] as const)("still gives an actionable error for a %s worktree", async condition => {
    let worktree = scope;
    if (condition === "missing") {
      // The recorded cwd still exists, so the reopen reaches the worktree check
      // rather than stopping at the spawn's cwd validation.
      worktree = { ...scope, path: join(root, "missing-worktree") };
    } else {
      git(scope.path, "switch", "-c", "changed-outside-pi");
    }
    const record = manager.restoreCompleted(await restoredRecord(worktree));

    // A startup failure is what the reopen reports back, rather than a run that
    // never began being announced as one.
    await expect(reopen(record, "continue")).rejects.toThrow(
      condition === "missing" ? /Worktree is missing:/ : /Worktree branch changed at/,
    );
    expect(runAgent).not.toHaveBeenCalled();
  });
});
