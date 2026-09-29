/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Every worktree checks out a real local branch and remains after settlement.
 * Explicit branches acquire reusable named workspaces; anonymous agents get
 * their own `pi/<agentId>` branch.
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
  lifecycle: "retained";
  /** Whether the caller supplied the branch name. */
  named: boolean;
  /** Caller branch at acquisition, or its HEAD SHA when detached. */
  baseRef: string;
  /** Origin repository root used for relative placement and configuration. */
  sourceRoot: string;
  /** Canonical common Git directory shared by all linked worktrees. */
  commonDir: string;
  reused: boolean;
  /** Refreshed when the scope is resumed. */
  initialDirty: boolean;
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Exact checked-out local branch. */
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
let worktreeAutoCommitEnabled = false;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export function setWorktreeAutoCommitEnabled(enabled: boolean): void {
  worktreeAutoCommitEnabled = enabled;
}

export function isWorktreeAutoCommitEnabled(): boolean {
  return worktreeAutoCommitEnabled;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found, or conservatively assumed after verification failed. */
  hasChanges: boolean;
  /** Exact checked-out branch name. */
  branch?: string;
  /** Why opt-in automatic staging or commit did not complete. */
  commitError?: string;
  /** Retained worktree path. */
  path?: string;
  retained?: true;
}

/**
 * A linked worktree was added, but its post-add verification did not complete.
 * The scope is recovery metadata: callers must retain and report it rather than
 * treating this like a failure that happened before Git acquired a path.
 */
export class WorktreeAcquisitionError extends Error {
  override readonly name = "WorktreeAcquisitionError";
  readonly code = "worktree_acquired";

  constructor(readonly worktree: WorktreeInfo, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Worktree acquired at ${worktree.path}, but verification failed: ${detail}`, { cause });
  }
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
  const key = worktree.named ? `branch:${worktree.branch}` : `path:${worktree.path}`;
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
  if (resolve(entries[0].path) === worktree.path) {
    throw new Error(`Retained worktree is now the main checkout: ${worktree.path}`);
  }
  const branch = await git(pi, worktree.path, ["rev-parse", "--symbolic-full-name", "HEAD"], 5000);
  const expected = `refs/heads/${worktree.branch}`;
  if (branch !== expected || matches[0].branch !== expected) {
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

/** Create an agent branch, or acquire a caller-selected exact local branch. */
export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
  options: WorktreeOptions = {},
): Promise<WorktreeInfo | undefined> {
  const named = options.branch !== undefined;
  if (named && !worktreeIsolationEnabled) throw new Error("Branch requires worktree isolation, which is disabled");
  let baseSha: string;
  let baseRef: string;
  let callerRoot: string;
  let commonDir: string;
  try {
    baseSha = await git(pi, cwd, ["rev-parse", "HEAD"], 5000);
    const callerBranch = await git(pi, cwd, ["branch", "--show-current"], 5000);
    baseRef = callerBranch || baseSha;
    callerRoot = realpathSync(await git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000));
    commonDir = await commonDirectory(pi, cwd);
  } catch (error) {
    if (named) throw error;
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
  const branch = options.branch ?? `pi/${agentId}`;
  const validated = await git(pi, cwd, ["check-ref-format", "--branch", branch], 5000);
  if (validated !== branch) throw new Error("Branch must be an exact local branch name, not a revision shortcut");
  await git(pi, cwd, ["check-ref-format", `refs/heads/${branch}`], 5000);
  const scope: WorktreeInfo = {
    path: "", workPath: "", branch, baseSha, baseRef, named, sourceRoot, commonDir,
    lifecycle: "retained", reused: false, initialDirty: false,
  };
  if (named) await acquireWorktreeLease(scope, agentId);
  try {
    if (named) {
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
    scope.path = join(container, named ? `${slug}-${hash(`${commonDir}\0${branch}`)}` : `${slug}-${randomUUID().slice(0, 8)}`);
    scope.workPath = join(scope.path, subdir);
    if (!named) await acquireWorktreeLease(scope, agentId);
    let args: string[];
    if (named) {
      const exists = await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, timeout: 5000 });
      if (exists.killed || (exists.code !== 0 && exists.code !== 1)) throw new Error(exists.stderr || "Cannot resolve local branch");
      args = exists.code === 0 ? ["worktree", "add", scope.path, branch]
        : ["worktree", "add", "-b", branch, scope.path, baseSha];
    } else {
      const parentBranch = await pi.exec("git", ["show-ref", "--verify", "--quiet", "refs/heads/pi"], { cwd, timeout: 5000 });
      if (parentBranch.killed || (parentBranch.code !== 0 && parentBranch.code !== 1)) {
        throw new Error(parentBranch.stderr || "Cannot check whether local branch `pi` exists");
      }
      if (parentBranch.code === 0) {
        throw new Error(`Cannot create generated branch ${branch}: local branch 'pi' prevents refs under 'pi/'; rename it or request an explicit branch`);
      }
      const generatedBranch = await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, timeout: 5000 });
      if (generatedBranch.killed || (generatedBranch.code !== 0 && generatedBranch.code !== 1)) {
        throw new Error(generatedBranch.stderr || `Cannot check whether generated branch ${branch} exists`);
      }
      if (generatedBranch.code === 0) {
        throw new Error(`Generated branch ${branch} already exists; use a different agent id or request an explicit branch`);
      }
      args = ["worktree", "add", "-b", branch, scope.path, baseSha];
    }
    try { await git(pi, cwd, args, 30000); }
    catch (error) {
      if (named) throw error;
      const parentBranch = await pi.exec("git", ["show-ref", "--verify", "--quiet", "refs/heads/pi"], { cwd, timeout: 5000 });
      if (parentBranch.code === 0) {
        throw new Error(`Cannot create generated branch ${branch}: local branch 'pi' prevents refs under 'pi/'; rename it or request an explicit branch`, { cause: error });
      }
      const generatedBranch = await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, timeout: 5000 });
      if (generatedBranch.code === 0) {
        throw new Error(`Generated branch ${branch} already exists; use a different agent id or request an explicit branch`, { cause: error });
      }
      releaseWorktreeLease(scope);
      return undefined;
    }
    try {
      scope.initialDirty = await verifyWorktree(pi, scope);
      scope.baseSha = await git(pi, scope.path, ["rev-parse", "HEAD"], 5000);
      return scope;
    } catch (error) {
      throw new WorktreeAcquisitionError(scope, error);
    }
  } catch (error) {
    releaseWorktreeLease(scope);
    throw error;
  }
}

/**
 * Optionally commit dirty work and report a settled worktree before releasing
 * its writer lease. Verification failures are strict for named worktrees and
 * conservative for agent-owned branches, which remain recovery locations.
 */
export async function cleanupWorktree(
  pi: ExtensionAPI,
  _cwd: string,
  worktree: WorktreeInfo,
  description: string,
  agentId: string,
): Promise<WorktreeCleanupResult> {
  try {
    const dirty = await verifyWorktree(pi, worktree);
    let commitError: string | undefined;
    if (dirty && worktreeAutoCommitEnabled) {
      try {
        await git(pi, worktree.path, ["add", "-A"], 30000);
        await git(pi, worktree.path, ["commit", "-m", `pi-subagents: ${description} (agent ${agentId})`], 30000);
      } catch (error) {
        commitError = error instanceof Error ? error.message : String(error);
      }
    }
    const stillDirty = await verifyWorktree(pi, worktree);
    const head = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000);
    return {
      hasChanges: stillDirty || head !== worktree.baseSha,
      branch: worktree.branch,
      ...(commitError ? { commitError } : {}),
      path: worktree.path,
      retained: true,
    };
  } catch (error) {
    if (worktree.named) throw error;
    return { hasChanges: true, branch: worktree.branch, path: worktree.path, retained: true };
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
