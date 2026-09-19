/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Anonymous copies are detached and retained in place after settlement.
 * Explicit branches acquire reusable retained workspaces.
 * Leases serialize extension-owned writers across processes through settlement.
 *
 * Every git call goes through `pi.exec` (async) rather than `execFileSync`: a
 * worktree copy can take seconds, and a session that spawns several isolated
 * agents at once would otherwise serialize them all on the TUI's event loop.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionArtifactRoot } from "./output-file.js";

export type WorktreeDirectory =
  | { mode: "session" }
  | { mode: "project" }
  | { mode: "custom"; path: string };

export interface WorktreeOptions {
  branch?: string;
  directory?: WorktreeDirectory;
  sessionRoot?: string;
  originCwd?: string;
}

export interface WorktreeInfo {
  lifecycle: "ephemeral" | "retained";
  /** Origin repository root used for relative placement and configuration. */
  sourceRoot: string;
  /** Canonical common Git directory shared by all linked worktrees. */
  commonDir: string;
  reused: boolean;
  /** Refreshed when the scope is resumed. */
  initialDirty: boolean;
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Exact checked-out branch for retained scopes; descriptive slug for anonymous copies. */
  branch: string;
  /** HEAD at acquisition, including the existing tip when reusing a branch. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found, or conservatively assumed after verification failed. */
  hasChanges: boolean;
  /** Exact branch name for a named retained worktree. */
  branch?: string;
  /** Retained worktree path. */
  path?: string;
  retained?: true;
}

/**
 * Run git and return its trimmed stdout, throwing on failure so callers keep
 * the try/catch control flow `execFileSync` gave them.
 *
 * `pi.exec` never rejects — it reports failure in the result — and a command
 * killed by its timeout comes back as `killed` with an exit code of 0, so both
 * have to be checked to reproduce `execFileSync`'s "throws on anything but a
 * clean exit".
 */
async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout: number): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

interface Registration { path: string; branch?: string; prunable: boolean }

async function registrations(pi: ExtensionAPI, cwd: string): Promise<Registration[]> {
  // Do not trim: NUL-separated paths can contain whitespace and newlines.
  const result = await pi.exec("git", ["worktree", "list", "--porcelain", "-z"], { cwd, timeout: 5000 });
  if (result.killed || result.code !== 0) throw new Error(result.stderr || "Cannot list Git worktrees");
  const entries: Registration[] = [];
  let entry: Registration | undefined;
  for (const field of result.stdout.split("\0")) {
    if (field.startsWith("worktree ")) {
      entry = { path: field.slice(9), prunable: false };
      entries.push(entry);
    } else if (entry && field.startsWith("branch ")) entry.branch = field.slice(7);
    else if (entry && (field === "prunable" || field.startsWith("prunable "))) entry.prunable = true;
  }
  return entries;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function commonDirectory(pi: ExtensionAPI, cwd: string): Promise<string> {
  return realpathSync(resolve(cwd, await git(pi, cwd, ["rev-parse", "--git-common-dir"], 5000)));
}

interface LeaseOwner { pid: number; host: string; boot: string; start?: string; token: string; agentId: string }

function bootIdentity(): string {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
  catch { return "unknown"; }
}

function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch { return undefined; }
}

function ownerAlive(owner: LeaseOwner): boolean {
  if (owner.host !== hostname()) return true; // Shared filesystems: never evict another host.
  const boot = bootIdentity();
  // Never infer a reboot from wall-clock time: an NTP correction must not
  // evict a live writer. Without a boot id, conservatively use PID liveness.
  if (owner.boot !== "unknown" && boot !== "unknown" && owner.boot !== boot) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  const start = processStart(owner.pid);
  return !owner.start || !start || owner.start === start;
}

function readLease(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * A hard link publishes a complete owner file atomically (no empty-file window),
 * without the elevated symlink privileges Windows would otherwise require.
 * Stale eviction is serialized by a generation-specific recovery lease, then
 * rechecks the generation: simultaneous reapers cannot unlink a new owner.
 * Recovery leases use the same protocol, so a crash during eviction is recoverable.
 */
function claimLease(path: string, owner: string, depth = 0): () => void {
  if (depth > 8) throw new Error(`Cannot recover worktree lease ${path}; inspect stale lease files`);
  const candidate = `${path}.${randomUUID()}.owner`;
  writeFileSync(candidate, owner, { flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        linkSync(candidate, path);
        return () => { if (readLease(path) === owner) unlinkSync(path); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const observed = readLease(path);
      if (observed === undefined) continue;
      let previous: LeaseOwner;
      try {
        previous = JSON.parse(observed) as LeaseOwner;
        if (!Number.isInteger(previous.pid) || previous.pid <= 0 || !previous.token || !previous.boot || !previous.host) throw new Error("Invalid owner");
      } catch { throw new Error(`Invalid worktree lease ${path}; inspect and remove it only if no agent owns the branch`); }
      if (ownerAlive(previous)) throw new Error(`Branch busy (agent ${previous.agentId}); steer/resume the owning agent or use another branch`);
      const release = claimLease(join(dirname(path), `${hash(path + observed)}.recovery`), owner, depth + 1);
      try { if (readLease(path) === observed) unlinkSync(path); }
      finally { release(); }
    }
    throw new Error("Branch busy; steer/resume the owning agent or use another branch");
  } finally { unlinkSync(candidate); }
}

const leases = new WeakMap<WorktreeInfo, () => void>();

/** Acquire before Git lookup/add; the caller holds this through execution and gates. */
export async function acquireWorktreeLease(worktree: WorktreeInfo, agentId: string): Promise<() => void> {
  if (leases.has(worktree)) throw new Error("Branch busy; this worktree already has an active lease");
  const directory = join(worktree.commonDir, "pi-subagents-leases");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = worktree.lifecycle === "retained" ? `branch:${worktree.branch}` : `path:${worktree.path}`;
  const owner: LeaseOwner = {
    pid: process.pid, host: hostname(), boot: bootIdentity(), start: processStart(process.pid),
    token: randomUUID(), agentId,
  };
  const unlock = claimLease(join(directory, `${hash(key)}.lock`), JSON.stringify(owner));
  const release = () => {
    if (leases.get(worktree) !== release) return;
    try { unlock(); } finally { leases.delete(worktree); }
  };
  leases.set(worktree, release);
  return release;
}

export function releaseWorktreeLease(worktree: WorktreeInfo): void { leases.get(worktree)?.(); }

async function verifyWorktree(pi: ExtensionAPI, worktree: WorktreeInfo): Promise<boolean> {
  if (!existsSync(worktree.path)) throw new Error(`Worktree is missing: ${worktree.path}; cannot resume or reuse it`);
  if (realpathSync(await git(pi, worktree.path, ["rev-parse", "--show-toplevel"], 5000)) !== worktree.path ||
      await commonDirectory(pi, worktree.path) !== worktree.commonDir) {
    throw new Error(`Worktree repository/path changed: ${worktree.path}`);
  }
  const entries = await registrations(pi, worktree.path);
  const matches = entries.filter(entry => resolve(entry.path) === worktree.path);
  if (matches.length !== 1 || matches[0].prunable) throw new Error(`Stale or ambiguous worktree registration: ${worktree.path}; inspect git worktree list`);
  if (worktree.lifecycle === "retained" && resolve(entries[0].path) === worktree.path) {
    throw new Error(`Retained worktree is now the main checkout: ${worktree.path}`);
  }
  const branch = await git(pi, worktree.path, ["rev-parse", "--symbolic-full-name", "HEAD"], 5000);
  const expected = worktree.lifecycle === "retained" ? `refs/heads/${worktree.branch}` : "HEAD";
  if (branch !== expected || (worktree.lifecycle === "retained" && matches[0].branch !== expected)) {
    throw new Error(`Worktree branch changed at ${worktree.path}; expected ${expected}`);
  }
  if (!inside(worktree.path, worktree.workPath) || !existsSync(worktree.workPath) ||
      !statSync(worktree.workPath).isDirectory() || !inside(worktree.path, realpathSync(worktree.workPath))) {
    throw new Error(`Scoped subdirectory is missing or outside the worktree: ${worktree.workPath}`);
  }
  return Boolean(await git(pi, worktree.path, ["status", "--porcelain"], 10000));
}

export async function resumeWorktree(pi: ExtensionAPI, worktree: WorktreeInfo, agentId: string): Promise<void> {
  await acquireWorktreeLease(worktree, agentId);
  try { worktree.initialDirty = await verifyWorktree(pi, worktree); }
  catch (error) { releaseWorktreeLease(worktree); throw error; }
}

/** Create an anonymous detached copy, or acquire a retained exact local branch. */
export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
  options: WorktreeOptions = {},
): Promise<WorktreeInfo | undefined> {
  const retained = options.branch !== undefined;
  if (retained && !worktreeIsolationEnabled) throw new Error("Branch requires worktree isolation, which is disabled");
  let baseSha: string;
  let callerRoot: string;
  let commonDir: string;
  try {
    baseSha = await git(pi, cwd, ["rev-parse", "HEAD"], 5000);
    callerRoot = realpathSync(await git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000));
    commonDir = await commonDirectory(pi, cwd);
  } catch (error) {
    if (retained) throw error;
    return undefined;
  }
  const entries = await registrations(pi, cwd);
  const mainRoot = entries[0]?.path;
  let sourceRoot = mainRoot && existsSync(mainRoot) ? realpathSync(mainRoot) : callerRoot;
  let originRoot = callerRoot;
  if (options.originCwd) {
    // An explicit cwd can target a different repository than the config project.
    // Only adopt the origin anchor when it belongs to this repository.
    try {
      if (await commonDirectory(pi, options.originCwd) === commonDir) {
        originRoot = realpathSync(await git(pi, options.originCwd, ["rev-parse", "--show-toplevel"], 5000));
        sourceRoot = mainRoot && existsSync(mainRoot) ? realpathSync(mainRoot) : originRoot;
      }
    } catch { /* Keep the target repository anchor. */ }
  }
  const subdir = relative(callerRoot, realpathSync(cwd));
  const branch = options.branch ?? `pi-agent-${agentId}`;
  if (retained) {
    const validated = await git(pi, cwd, ["check-ref-format", "--branch", branch], 5000);
    if (validated !== branch) throw new Error("Branch must be an exact local branch name, not a revision shortcut");
    await git(pi, cwd, ["check-ref-format", `refs/heads/${branch}`], 5000);
  }
  const scope: WorktreeInfo = {
    path: "", workPath: "", branch, baseSha, sourceRoot, commonDir,
    lifecycle: retained ? "retained" : "ephemeral", reused: false, initialDirty: false,
  };
  if (retained) await acquireWorktreeLease(scope, agentId);
  try {
    if (retained) {
      const matches = (await registrations(pi, cwd)).filter(entry => entry.branch === `refs/heads/${branch}`);
      if (matches.length > 1) throw new Error(`Ambiguous worktree registrations for branch ${branch}`);
      if (matches.length === 1) {
        const target = matches[0];
        if (target.prunable || !existsSync(target.path)) throw new Error(`Stale worktree for ${branch}: ${target.path}; inspect git worktree list and repair the registration`);
        scope.path = realpathSync(target.path);
        if (scope.path === sourceRoot || scope.path === callerRoot || scope.path === originRoot) {
          throw new Error(`Branch ${branch} belongs to the main/orchestrating checkout; use another branch`);
        }
        scope.workPath = join(scope.path, subdir);
        scope.reused = true;
        scope.initialDirty = await verifyWorktree(pi, scope);
        scope.baseSha = await git(pi, scope.path, ["rev-parse", "HEAD"], 5000);
        return scope;
      }
    }
    const placement = options.directory ?? { mode: "session" };
    let container = placement.mode === "project" ? join(sourceRoot, ".worktrees")
      : placement.mode === "custom" ? resolve(sourceRoot, placement.path)
      : join(options.sessionRoot ?? sessionArtifactRoot(options.originCwd ?? cwd, "standalone"), "worktrees");
    if (placement.mode === "custom") container = join(container, hash(commonDir));
    // Canonicalize through existing ancestors so symlinked custom paths cannot
    // bypass the repository-internal ignore check.
    let ancestor = container;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    container = resolve(realpathSync(ancestor), relative(ancestor, container));
    for (const root of new Set([sourceRoot, callerRoot, originRoot, ...entries.filter(entry => existsSync(entry.path)).map(entry => realpathSync(entry.path))])) {
      if (!inside(root, container)) continue;
      const ignored = await pi.exec("git", ["check-ignore", "-q", "--", `${relative(root, container)}/`], { cwd: root, timeout: 5000 });
      if (ignored.killed || ignored.code !== 0) {
        throw new Error(`Worktree container ${container} is inside the repository and is not ignored. Add /${relative(root, container).split(sep).join("/")}/ to ${join(commonDir, "info", "exclude")} before retrying; no tracked .gitignore is edited automatically`);
      }
    }
    mkdirSync(container, { recursive: true, mode: 0o700 });
    const slug = branch.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64) || "branch";
    scope.path = join(container, retained ? `${slug}-${hash(`${commonDir}\0${branch}`)}` : `${slug}-${randomUUID().slice(0, 8)}`);
    scope.workPath = join(scope.path, subdir);
    if (!retained) await acquireWorktreeLease(scope, agentId);
    let args: string[];
    if (retained) {
      const exists = await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, timeout: 5000 });
      if (exists.killed || (exists.code !== 0 && exists.code !== 1)) throw new Error(exists.stderr || "Cannot resolve local branch");
      args = exists.code === 0 ? ["worktree", "add", scope.path, branch]
        : ["worktree", "add", "-b", branch, scope.path, baseSha];
    } else args = ["worktree", "add", "--detach", scope.path, baseSha];
    try { await git(pi, cwd, args, 30000); }
    catch (error) {
      if (retained) throw error;
      releaseWorktreeLease(scope);
      return undefined;
    }
    scope.initialDirty = await verifyWorktree(pi, scope);
    scope.baseSha = await git(pi, scope.path, ["rev-parse", "HEAD"], 5000);
    return scope;
  } catch (error) {
    releaseWorktreeLease(scope);
    throw error;
  }
}

/**
 * Verify and report a settled worktree, then release its writer lease.
 * Settlement never stages, commits, creates a branch, resets, stashes, cleans,
 * or removes the workspace. Anonymous worktrees remain detached in place.
 *
 * A named workspace keeps its strict verification behavior. An anonymous
 * workspace reports changes conservatively when its state cannot be verified:
 * the retained path is still the authoritative recovery location.
 */
export async function cleanupWorktree(
  pi: ExtensionAPI,
  _cwd: string,
  worktree: WorktreeInfo,
  _agentDescription: string,
): Promise<WorktreeCleanupResult> {
  try {
    const dirty = await verifyWorktree(pi, worktree);
    const head = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000);
    return {
      hasChanges: dirty || head !== worktree.baseSha,
      ...(worktree.lifecycle === "retained" ? { branch: worktree.branch } : {}),
      path: worktree.path,
      retained: true,
    };
  } catch (error) {
    if (worktree.lifecycle === "retained") throw error;
    return { hasChanges: true, path: worktree.path, retained: true };
  } finally {
    releaseWorktreeLease(worktree);
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "prune"], 5000);
  } catch { /* ignore */ }
}
