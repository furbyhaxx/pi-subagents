import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupWorktree,
  createWorktree,
  isWorktreeAutoCommitEnabled,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
  setWorktreeAutoCommitEnabled,
  setWorktreeIsolationEnabled,
  WorktreeAcquisitionError,
} from "../src/worktree.js";

/**
 * Minimal stand-in for pi.exec(): runs the command for real, and — like the
 * host's implementation — REPORTS failure in the result instead of rejecting.
 * The source has to read `code`/`killed` rather than rely on a throw, so a stub
 * that threw would hide the branch that matters.
 */
function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; status?: number };
        return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? 1, killed: false };
      }
    },
  } as unknown as ExtensionAPI;
}

/**
 * A pi whose exec answers one git subcommand with a canned failure result and
 * runs everything else for real. `match` sees the argv git is called with.
 */
async function createNamedTestWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
  options: Parameters<typeof createWorktree>[3] = {},
) {
  return createWorktree(pi, cwd, agentId, { ...options, branch: options.branch ?? `feat/${agentId}` });
}

function failingPi(match: (args: string[]) => boolean, failure: { code: number; killed: boolean }): ExtensionAPI {
  const real = mockPi();
  return {
    exec: vi.fn(async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      if (match(args)) return { stdout: "", stderr: "boom", ...failure };
      return real.exec(command, args, options);
    }),
  } as unknown as ExtensionAPI;
}

/**
 * Helper: create a temporary git repo with an initial commit.
 */
function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

let artifactDir: string;
beforeEach(() => {
  artifactDir = mkdtempSync(join(tmpdir(), "pi-wt-artifacts-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", artifactDir);
  // Sandboxed: an inherited session root would move the default artifact container.
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  setWorktreeAutoCommitEnabled(false);
  rmSync(artifactDir, { recursive: true, force: true });
});

describe("worktree", () => {
  let repoDir: string;
  let pi: ExtensionAPI;

  beforeEach(() => {
    repoDir = initGitRepo();
    pi = mockPi();
  });

  afterEach(async () => {
    // Clean up any lingering worktrees first, then remove repo
    try { await pruneWorktrees(pi, repoDir); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("createWorktree", () => {
    it("creates a worktree under persistent session artifacts", async () => {
      const wt = await createNamedTestWorktree(pi, repoDir, "test-id-1");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.branch).toBe("feat/test-id-1");
      expect(wt!.path.startsWith(artifactDir)).toBe(true);
      expect(wt!.lifecycle).toBe("retained");
      expect(wt!.named).toBe(true);
      expect(wt!.baseRef).toBe(execFileSync("git", ["branch", "--show-current"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim());
      expect(wt!.baseSha).toBe(execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim());
      expect(execFileSync("git", ["rev-parse", "--symbolic-full-name", "HEAD"], {
        cwd: wt!.path, stdio: "pipe",
      }).toString().trim()).toBe("refs/heads/feat/test-id-1");
      expect(execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads/feat/test-id-1"], {
        cwd: repoDir, encoding: "utf8",
      }).trim()).toBe("refs/heads/feat/test-id-1");

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("fails when the requested branch cannot be created outside a git repo", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        await expect(createNamedTestWorktree(pi, nonGit, "test-id-2")).rejects.toThrow();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("fails when the requested branch cannot be created before the first commit", async () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        await expect(createNamedTestWorktree(pi, emptyRepo, "no-commits")).rejects.toThrow();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("fails when `git worktree add` reports a non-zero exit", async () => {
      // pi.exec resolves with a failure code instead of throwing, so a port that
      // only caught exceptions would hand back a worktree path that isn't there.
      await expect(createNamedTestWorktree(
        failingPi(args => args[0] === "worktree" && args[1] === "add", { code: 128, killed: false }),
        repoDir,
        "add-fails",
      )).rejects.toThrow("boom");
    });

    it("fails when a git call is killed by its timeout", async () => {
      // A killed process reports code 0 with killed: true — the one failure
      // shape that looks like success if only the exit code is checked.
      await expect(createNamedTestWorktree(
        failingPi(args => args[0] === "rev-parse" && args[1] === "HEAD", { code: 0, killed: true }),
        repoDir,
        "timed-out",
      )).rejects.toThrow("boom");
    });

    it("surfaces the acquired path when post-add verification fails", async () => {
      const real = mockPi();
      let added = false;
      const postAddFailure = {
        exec: vi.fn(async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
          if (added && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
            return { stdout: "", stderr: "verification failed", code: 128, killed: false };
          }
          const result = await real.exec(command, args, options);
          if (args[0] === "worktree" && args[1] === "add" && result.code === 0) added = true;
          return result;
        }),
      } as unknown as ExtensionAPI;

      let failure: unknown;
      try {
        await createNamedTestWorktree(postAddFailure, repoDir, "verify-fails");
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(WorktreeAcquisitionError);
      const acquired = (failure as WorktreeAcquisitionError).worktree;
      expect(acquired.branch).toBe("feat/verify-fails");
      expect(acquired.path).toContain("feat-verify-fails");
      expect(existsSync(acquired.path)).toBe(true);
      expect((failure as Error).message).toContain(acquired.path);
      execFileSync("git", ["worktree", "remove", "--force", acquired.path], { cwd: repoDir, stdio: "pipe" });
    });

    it("uses the caller HEAD SHA as baseRef when the caller is detached", async () => {
      execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: repoDir, stdio: "pipe" });
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
      const wt = (await createNamedTestWorktree(pi, repoDir, "detached-base"))!;
      expect(wt.baseRef).toBe(head);
      expect(wt.baseSha).toBe(head);
      execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" });
    });

    it("workPath equals path when created from the repo root", async () => {
      const wt = (await createNamedTestWorktree(pi, repoDir, "root-wp"))!;
      expect(wt.workPath).toBe(wt.path);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("workPath preserves subdirectory scoping (monorepo package cwd)", async () => {
      mkdirSync(join(repoDir, "packages", "api"), { recursive: true });
      writeFileSync(join(repoDir, "packages", "api", "index.ts"), "export {}");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "add package"], { cwd: repoDir, stdio: "pipe" });

      const wt = (await createNamedTestWorktree(pi, join(repoDir, "packages", "api"), "subdir-wp"))!;
      expect(wt).toBeDefined();
      expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
      expect(existsSync(wt.workPath)).toBe(true);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("requires an explicit branch instead of generating one from the agent id", async () => {
      await expect(createWorktree(pi, repoDir, "anonymous")).rejects.toThrow(
        'Worktree isolation requires an explicit branch; pass branch: "feat/<slug>"',
      );
      expect(execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads/feat"], { cwd: repoDir, encoding: "utf8" }).trim()).toBe("");
      expect(execFileSync("git", ["worktree", "list"], { cwd: repoDir, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
    });

    it("uses unique paths for multiple worktrees", async () => {
      const wt1 = await createNamedTestWorktree(pi, repoDir, "multi-1");
      const wt2 = await createNamedTestWorktree(pi, repoDir, "multi-2");
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt1!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["worktree", "remove", "--force", wt2!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("creates worktrees concurrently — the git calls do not serialize on one another", async () => {
      // The reason for the port: several isolated agents can start at once, so
      // no call may block the caller until the previous one has finished.
      const order: string[] = [];
      const tracking = {
        exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
          order.push(`start:${args[0]}`);
          const result = await pi.exec(command, args, options);
          order.push(`end:${args[0]}`);
          return result;
        },
      } as unknown as ExtensionAPI;

      const [a, b] = await Promise.all([
        createNamedTestWorktree(tracking, repoDir, "par-1"),
        createNamedTestWorktree(tracking, repoDir, "par-2"),
      ]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      // Interleaving proves the two chains ran together: with blocking calls the
      // log would be strictly start/end paired.
      const interleaved = order.some((entry, i) => entry.startsWith("start:") && order[i + 1]?.startsWith("start:"));
      expect(interleaved).toBe(true);

      for (const wt of [a!, b!]) {
        try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      }
    });
  });

  describe("cleanupWorktree", () => {
    it("retains a clean agent branch in place", async () => {
      const wt = (await createNamedTestWorktree(pi, repoDir, "clean-1"))!;

      const result = await cleanupWorktree(pi, repoDir, wt, "test settlement", "clean-1");

      expect(result).toEqual({ hasChanges: false, branch: wt.branch, path: wt.path, retained: true });
      expect(existsSync(wt.path)).toBe(true);
      expect(execFileSync("git", ["rev-parse", "--symbolic-full-name", "HEAD"], {
        cwd: wt.path, stdio: "pipe",
      }).toString().trim()).toBe(`refs/heads/${wt.branch}`);
      expect(execFileSync("git", ["for-each-ref", "--format=%(refname)", `refs/heads/${wt.branch}`], {
        cwd: repoDir, encoding: "utf8",
      }).trim()).toBe(`refs/heads/${wt.branch}`);
    });

    it("retains uncommitted changes without staging or committing", async () => {
      const wt = (await createNamedTestWorktree(pi, repoDir, "dirty-1"))!;
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt.path, stdio: "pipe" }).toString().trim();

      const result = await cleanupWorktree(pi, repoDir, wt, "added new file", "dirty-1");

      expect(result).toEqual({ hasChanges: true, branch: wt.branch, path: wt.path, retained: true });
      expect(existsSync(join(wt.path, "new-file.txt"))).toBe(true);
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: wt.path, stdio: "pipe" }).toString()).toContain("?? new-file.txt");
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt.path, stdio: "pipe" }).toString().trim()).toBe(head);
      expect(execFileSync("git", ["for-each-ref", "--format=%(refname)", `refs/heads/${wt.branch}`], { cwd: repoDir, encoding: "utf8" }).trim()).toBe(`refs/heads/${wt.branch}`);
    });

    it("does not create an empty commit when auto-commit is enabled for a clean worktree", async () => {
      const wt = (await createNamedTestWorktree(pi, repoDir, "auto-commit-clean"))!;
      setWorktreeAutoCommitEnabled(true);

      const result = await cleanupWorktree(pi, repoDir, wt, "nothing changed", "agent-clean");

      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt.path, encoding: "utf8" }).trim()).toBe(wt.baseSha);
      expect(result).toEqual({ hasChanges: false, branch: wt.branch, path: wt.path, retained: true });
    });

    it("auto-commits dirty work with the configured description and agent id", async () => {
      const wt = (await createNamedTestWorktree(pi, repoDir, "auto-commit-1"))!;
      writeFileSync(join(wt.path, "auto-committed.txt"), "settled work");
      setWorktreeAutoCommitEnabled(true);

      const result = await cleanupWorktree(pi, repoDir, wt, "implement parser", "agent-42");

      expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: wt.path, encoding: "utf8" }).trim())
        .toBe("pi-subagents: implement parser (agent agent-42)");
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: wt.path, encoding: "utf8" }).trim()).toBe("");
      expect(result).toEqual({ hasChanges: true, branch: wt.branch, path: wt.path, retained: true });
    });

    it("reports automatic commit failures without throwing or discarding staged work", async () => {
      const wt = (await createNamedTestWorktree(pi, repoDir, "auto-commit-fails"))!;
      writeFileSync(join(wt.path, "uncommitted.txt"), "keep this");
      setWorktreeAutoCommitEnabled(true);

      const result = await cleanupWorktree(
        failingPi(args => args[0] === "commit", { code: 1, killed: false }),
        repoDir,
        wt,
        "write feature",
        "agent-fails",
      );

      expect(result.commitError).toBe("boom");
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: wt.path, encoding: "utf8" })).toContain("A  uncommitted.txt");
    });

    it("retains agent commits on their branch", async () => {
      const wt = (await createNamedTestWorktree(pi, repoDir, "committed-1"))!;
      writeFileSync(join(wt.path, "committed-file.txt"), "agent committed this");
      execFileSync("git", ["add", "committed-file.txt"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "agent commit"], { cwd: wt.path, stdio: "pipe" });
      const agentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt.path, stdio: "pipe" }).toString().trim();

      const result = await cleanupWorktree(pi, repoDir, wt, "already committed", "committed-1");

      expect(result).toEqual({ hasChanges: true, branch: wt.branch, path: wt.path, retained: true });
      expect(existsSync(wt.path)).toBe(true);
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt.path, stdio: "pipe" }).toString().trim()).toBe(agentCommit);
      expect(execFileSync("git", ["for-each-ref", "--format=%(refname)", `refs/heads/${wt.branch}`], { cwd: repoDir, encoding: "utf8" }).trim()).toBe(`refs/heads/${wt.branch}`);
    });

    it("uses conservative change metadata when an agent branch cannot be verified", async () => {
      const wt = (await createNamedTestWorktree(pi, repoDir, "corrupt", { branch: "pi/corrupt" }))!;
      wt.named = false;
      writeFileSync(join(wt.path, "work.txt"), "agent output");
      writeFileSync(join(wt.path, ".git"), "gitdir: /nonexistent/path/that/is/not/a/repo");

      const result = await cleanupWorktree(pi, repoDir, wt, "corrupted agent", "corrupt");

      expect(result).toEqual({ hasChanges: true, branch: wt.branch, path: wt.path, retained: true });
      expect(readFileSync(join(wt.path, "work.txt"), "utf8")).toBe("agent output");
    });

    it("never invokes a mutating settlement command", async () => {
      const wt = (await createNamedTestWorktree(pi, repoDir, "observed"))!;
      writeFileSync(join(wt.path, "work.txt"), "agent output");
      const observed = { ...pi, exec: vi.fn(pi.exec.bind(pi)) } as ExtensionAPI;

      await cleanupWorktree(observed, repoDir, wt, "observe commands", "observed");

      const calls = vi.mocked(observed.exec).mock.calls.map(([, args]) => args.join(" "));
      expect(calls.some(args => /^(add|commit|branch|reset|stash|clean)\b/.test(args))).toBe(false);
      expect(calls.some(args => args.startsWith("worktree remove"))).toBe(false);
    });
  });

  describe("pruneWorktrees", () => {
    it("does not reject on a clean repo", async () => {
      await expect(pruneWorktrees(pi, repoDir)).resolves.toBeUndefined();
    });

    it("does not reject on non-git directory", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        await expect(pruneWorktrees(pi, nonGit)).resolves.toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});

/**
 * The project switch itself (`worktreeIsolation`, #184). Its consumers —
 * agent-manager, both tool schemas, the invocation resolver — all mock this
 * module, so without this block the real singleton is never executed and its
 * default is never exercised. That default is what every "worktree isolation
 * still behaves as before" claim rests on.
 */
describe("worktree auto-commit switch", () => {
  afterEach(() => setWorktreeAutoCommitEnabled(false));

  it("defaults to disabled and applies changes live", () => {
    expect(isWorktreeAutoCommitEnabled()).toBe(false);
    setWorktreeAutoCommitEnabled(true);
    expect(isWorktreeAutoCommitEnabled()).toBe(true);
    setWorktreeAutoCommitEnabled(false);
    expect(isWorktreeAutoCommitEnabled()).toBe(false);
  });
});

describe("worktree isolation switch", () => {
  afterEach(() => setWorktreeIsolationEnabled(true));

  it("defaults to enabled", () => {
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  it("round-trips both ways", () => {
    setWorktreeIsolationEnabled(false);
    expect(isWorktreeIsolationEnabled()).toBe(false);
    setWorktreeIsolationEnabled(true);
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  it("refuses explicit worktree creation when disabled", async () => {
    const repoDir = initGitRepo();
    const pi = mockPi();
    try {
      setWorktreeIsolationEnabled(false);
      await expect(createNamedTestWorktree(pi, repoDir, "switch-test")).rejects.toThrow(/disabled/);
    } finally {
      await pruneWorktrees(pi, repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
