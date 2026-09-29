import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function realExec(failPrune = false) {
  return async (command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) => {
    if (failPrune && args[0] === "worktree" && args[1] === "prune") {
      return { stdout: "", stderr: "prune failed", code: 1, killed: false };
    }
    try {
      const stdout = execFileSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: options.timeout,
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
  };
}

let hermetic: Hermetic | undefined;
let linkedRoot: string | undefined;

afterEach(() => {
  if (linkedRoot) rmSync(linkedRoot, { recursive: true, force: true });
  linkedRoot = undefined;
  hermetic?.restore();
  hermetic = undefined;
  vi.restoreAllMocks();
});

async function startSession(failPrune: boolean) {
  hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false, messaging: { enabled: false } } });
  const repo = hermetic.dir;
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  linkedRoot = mkdtempSync(join(tmpdir(), "pi-wt-prune-"));
  const linked = join(linkedRoot, "linked");
  git(repo, "worktree", "add", "-b", "feature/session", linked);

  const booted = makePi();
  vi.mocked(booted.pi.exec).mockImplementation(realExec(failPrune));
  subagentsExtension(booted.pi);
  const context = ctx({
    cwd: linked,
    sessionManager: { getSessionId: vi.fn(() => undefined) },
  });
  const handler = booted.lifecycle.get("session_start");
  if (!handler) throw new Error("the extension did not register session_start");
  await handler({}, context);
  return { repo, booted };
}

describe("session-start worktree pruning", () => {
  it("prunes registrations from the origin repository", async () => {
    const { repo, booted } = await startSession(false);
    const prune = vi.mocked(booted.pi.exec).mock.calls.find(([, args]) => args[0] === "worktree" && args[1] === "prune");

    expect(prune?.[0]).toBe("git");
    expect(prune?.[1]).toEqual(["worktree", "prune"]);
    expect(prune?.[2]).toMatchObject({ cwd: repo });
  });

  it("does not fail session start when git worktree prune fails", async () => {
    const { booted } = await startSession(true);

    expect(vi.mocked(booted.pi.exec).mock.calls.some(([, args]) => args[0] === "worktree" && args[1] === "prune")).toBe(true);
  });
});
