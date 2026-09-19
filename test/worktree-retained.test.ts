import { execFile, execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireWorktreeLease, cleanupWorktree, createWorktree, releaseWorktreeLease, resumeWorktree,
  setWorktreeIsolationEnabled, type WorktreeInfo,
} from "../src/worktree.js";

const exec = promisify(execFile);
const pi = {
  exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
    try {
      const { stdout, stderr } = await exec(command, args, { ...options, encoding: "utf8" });
      return { stdout, stderr, code: 0, killed: false };
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 1, killed: result.killed ?? false };
    }
  },
} as unknown as ExtensionAPI;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

let root: string;
let repo: string;
let sessionRoot: string;
const scopes: WorktreeInfo[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-wt-retained-"));
  repo = join(root, "repo");
  sessionRoot = join(root, "session");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  mkdirSync(join(repo, "packages", "api"), { recursive: true });
  writeFileSync(join(repo, "packages", "api", "index.txt"), "initial\n");
  git(repo, "add", "packages");
  git(repo, "commit", "-m", "initial");
});

afterEach(() => {
  for (const scope of scopes.splice(0)) releaseWorktreeLease(scope);
  setWorktreeIsolationEnabled(true);
  rmSync(root, { recursive: true, force: true });
});

async function create(branch?: string, cwd = repo): Promise<WorktreeInfo> {
  const scope = (await createWorktree(pi, cwd, `agent-${scopes.length}`, { branch, sessionRoot }))!;
  scopes.push(scope);
  return scope;
}

describe("retained branch worktrees", () => {
  it("creates exact local branch at caller HEAD without copying parent edits, and never commits/removes on settlement", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "parent-only.txt"), "parent dirty");
    const scope = await create("feat/one", join(repo, "packages", "api"));
    expect(scope).toMatchObject({ lifecycle: "retained", reused: false, initialDirty: false, sourceRoot: repo, commonDir: join(repo, ".git"), baseSha: head });
    expect(scope.path.startsWith(join(sessionRoot, "worktrees"))).toBe(true);
    expect(scope.workPath).toBe(join(scope.path, "packages", "api"));
    expect(git(scope.path, "branch", "--show-current")).toBe("feat/one");
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(existsSync(join(scope.path, "parent-only.txt"))).toBe(false);
    writeFileSync(join(scope.workPath, "index.txt"), "staged\n");
    git(scope.path, "add", "packages");
    writeFileSync(join(scope.workPath, "index.txt"), "unstaged\n");
    writeFileSync(join(scope.path, "untracked.txt"), "retain me");
    const before = git(scope.path, "status", "--porcelain");
    expect(await cleanupWorktree(pi, repo, scope, "done")).toEqual({ hasChanges: true, branch: "feat/one", path: scope.path, retained: true });
    expect(git(scope.path, "status", "--porcelain")).toBe(before);
    expect(git(scope.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(scope.path, "show", ":packages/api/index.txt")).toBe("staged");
    expect(readFileSync(join(scope.workPath, "index.txt"), "utf8")).toBe("unstaged\n");
  });

  it("reuses a registered dirty tree outside placement and preserves its branch tip", async () => {
    const existing = join(root, "human workspace\nwith newline");
    git(repo, "worktree", "add", "-b", "human/topic", existing);
    writeFileSync(join(existing, "extra.txt"), "committed");
    git(existing, "add", "extra.txt");
    git(existing, "commit", "-m", "human commit");
    writeFileSync(join(existing, "extra.txt"), "dirty");
    const scope = await create("human/topic");
    expect(scope.path).toBe(existing);
    expect(scope.reused).toBe(true);
    expect(scope.initialDirty).toBe(true);
    expect(scope.baseSha).toBe(git(existing, "rev-parse", "HEAD"));
    await cleanupWorktree(pi, repo, scope, "no edits");
    expect(readFileSync(join(existing, "extra.txt"), "utf8")).toBe("dirty");
  });

  it("uses an existing local branch tip and creates missing branches at a linked caller's HEAD", async () => {
    git(repo, "branch", "old-tip");
    const caller = await create("caller");
    writeFileSync(join(caller.path, "caller.txt"), "commit");
    git(caller.path, "add", "caller.txt");
    git(caller.path, "commit", "-m", "caller commit");
    const existing = await create("old-tip", caller.workPath);
    const fresh = await create("child", caller.workPath);
    expect(existing.baseSha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(fresh.baseSha).toBe(git(caller.path, "rev-parse", "HEAD"));
    expect(fresh.sourceRoot).toBe(repo);
    expect(fresh.commonDir).toBe(caller.commonDir);
    await expect(create("caller", caller.path)).rejects.toThrow(/busy/);
    releaseWorktreeLease(caller);
    await expect(create("caller", caller.path)).rejects.toThrow(/main\/orchestrating/);
  });

  it("rejects main/orchestrating branches, revision shortcuts, stale registrations and missing scoped directories", async () => {
    await expect(create("main")).rejects.toThrow(/main\/orchestrating/);
    await expect(create("bad..branch")).rejects.toThrow();
    await expect(create("HEAD~1")).rejects.toThrow();
    git(repo, "branch", "without-package");
    const old = join(root, "old");
    git(repo, "worktree", "add", old, "without-package");
    git(old, "rm", "-r", "packages");
    git(old, "commit", "--allow-empty", "-m", "remove package");
    await expect(create("without-package", join(repo, "packages", "api"))).rejects.toThrow(/Scoped subdirectory/);
    rmSync(old, { recursive: true, force: true });
    await expect(create("without-package")).rejects.toThrow(/Stale worktree/);
    setWorktreeIsolationEnabled(false);
    await expect(create("disabled")).rejects.toThrow(/disabled/);
  });

  it("holds a lease through settlement, rejects concurrent acquisitions, and reacquires during resume", async () => {
    const results = await Promise.allSettled([create("contended"), create("contended")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const scope = scopes[0];
    await expect(acquireWorktreeLease({ ...scope }, "other-process-record")).rejects.toThrow(/busy/);
    await cleanupWorktree(pi, repo, scope, "settled");
    writeFileSync(join(scope.path, "resumed.txt"), "dirty before resume");
    await resumeWorktree(pi, scope, "resume-agent");
    expect(scope.initialDirty).toBe(true);
    await expect(create("contended")).rejects.toThrow(/busy/);
    releaseWorktreeLease(scope);
    git(scope.path, "switch", "-c", "changed-externally");
    await expect(resumeWorktree(pi, scope, "resume-agent")).rejects.toThrow(/branch changed/);
    const unlock = await acquireWorktreeLease({ ...scope }, "after-failed-resume");
    unlock();
  });

  it("reacquires a settled anonymous worktree and releases retained leases even when status fails", async () => {
    const anonymous = await create();
    expect(await cleanupWorktree(pi, repo, anonymous, "done")).toEqual({
      hasChanges: false, path: anonymous.path, retained: true,
    });
    expect(existsSync(anonymous.path)).toBe(true);
    await resumeWorktree(pi, anonymous, "resume");
    expect(anonymous.initialDirty).toBe(false);
    releaseWorktreeLease(anonymous);
    const scope = await create("broken");
    writeFileSync(join(scope.path, "keep.txt"), "do not delete");
    writeFileSync(join(scope.path, ".git"), "gitdir: /missing/git-dir");
    await expect(cleanupWorktree(pi, repo, scope, "failure")).rejects.toThrow();
    expect(readFileSync(join(scope.path, "keep.txt"), "utf8")).toBe("do not delete");
    const unlock = await acquireWorktreeLease({ ...scope }, "next");
    unlock();
  });

  it("refuses a separate live process and recovers its lease after termination", async () => {
    const scope = await create("process-owner");
    const key = createHash("sha256").update(`branch:${scope.branch}`).digest("hex").slice(0, 16);
    const lock = join(scope.commonDir, "pi-subagents-leases", `${key}.lock`);
    const owner = readFileSync(lock, "utf8");
    releaseWorktreeLease(scope);
    const script = join(root, "lease-owner.cjs");
    writeFileSync(script, [
      'const { writeFileSync } = require("node:fs");',
      'const owner = { ...JSON.parse(process.argv[3]), pid: process.pid, start: undefined };',
      'writeFileSync(process.argv[2], JSON.stringify(owner), { flag: "wx" });',
      'process.send("ready");',
      'setInterval(() => {}, 1000);',
    ].join("\n"));
    const child = fork(script, [lock, owner], { silent: true });
    try {
      await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("Lease owner exited before ready"); })]);
      await expect(create("process-owner")).rejects.toThrow(/busy/);
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await resumeWorktree(pi, scope, "after-process-exit");
    expect(scope.path).toBeDefined();
  });

  it("recovers reboot/dead-process leases and refuses a live process owner", async () => {
    const scope = await create("lease-recovery");
    const key = createHash("sha256").update(`branch:${scope.branch}`).digest("hex").slice(0, 16);
    const lock = join(scope.commonDir, "pi-subagents-leases", `${key}.lock`);
    const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; boot: string; host: string; token: string };
    releaseWorktreeLease(scope);
    writeFileSync(lock, JSON.stringify({ ...owner, boot: "previous-boot", host: hostname() }), { flag: "wx" });
    await resumeWorktree(pi, scope, "after-reboot");
    releaseWorktreeLease(scope);
    writeFileSync(lock, JSON.stringify({ ...owner, pid: 2147483647 }), { flag: "wx" });
    await resumeWorktree(pi, scope, "after-death");
    releaseWorktreeLease(scope);
    writeFileSync(lock, JSON.stringify(owner), { flag: "wx" });
    await expect(resumeWorktree(pi, scope, "live-owner")).rejects.toThrow(/busy/);
    unlinkSync(lock);
  });
});

describe("worktree placement", () => {
  it("requires ignored internal containers, anchors nested project placement, and does not edit tracked ignore files", async () => {
    await expect(createWorktree(pi, repo, "project", { branch: "project", directory: { mode: "project" } })).rejects.toThrow(/info\/exclude/);
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    writeFileSync(join(repo, ".git", "info", "exclude"), "/.worktrees/\n");
    const parent = (await createWorktree(pi, repo, "project", { branch: "project", directory: { mode: "project" } }))!;
    scopes.push(parent);
    const child = (await createWorktree(pi, parent.workPath, "nested", {
      branch: "nested", originCwd: parent.workPath, directory: { mode: "project" },
    }))!;
    scopes.push(child);
    expect(parent.path.startsWith(join(repo, ".worktrees"))).toBe(true);
    expect(child.path.startsWith(join(repo, ".worktrees"))).toBe(true);
    expect(child.path.startsWith(parent.path)).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("anchors relative custom containers to the target repository, namespaces shared containers, and honors absolute placement", async () => {
    writeFileSync(join(repo, ".git", "info", "exclude"), "/custom/\n");
    const caller = await create("caller-custom");
    const relative = (await createWorktree(pi, caller.path, "relative", {
      branch: "feat/x", originCwd: root, directory: { mode: "custom", path: "custom" },
    }))!;
    scopes.push(relative);
    expect(relative.sourceRoot).toBe(repo);
    expect(relative.path.startsWith(join(repo, "custom"))).toBe(true);
    const absolute = (await createWorktree(pi, repo, "absolute", {
      branch: "feat-x", directory: { mode: "custom", path: join(root, "shared") },
    }))!;
    scopes.push(absolute);
    expect(absolute.path.startsWith(join(root, "shared"))).toBe(true);
    expect(absolute.path.split("/").at(-2)).toBe(relative.path.split("/").at(-2));
    expect(absolute.path.split("/").at(-1)).not.toBe(relative.path.split("/").at(-1));
    const otherRepo = join(root, "other-repo");
    git(root, "clone", "--no-local", repo, otherRepo);
    const other = (await createWorktree(pi, otherRepo, "other", {
      branch: "feat-x", originCwd: repo, directory: { mode: "custom", path: join(root, "shared") },
    }))!;
    scopes.push(other);
    expect(other.sourceRoot).toBe(otherRepo);
    expect(other.path.split("/").at(-2)).not.toBe(absolute.path.split("/").at(-2));
    const sameSession = (await createWorktree(pi, otherRepo, "other-session", { branch: "caller-custom", sessionRoot }))!;
    scopes.push(sameSession);
    expect(sameSession.path.startsWith(join(sessionRoot, "worktrees"))).toBe(true);
    expect(sameSession.path).not.toBe(caller.path);
  });
});
