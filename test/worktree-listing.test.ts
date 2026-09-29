import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { listWorktreeRows, type WorktreeListingExec } from "../src/worktree.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

const gitExec: WorktreeListingExec = async (command, args, options) => {
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

function initGitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.email", "test@example.com");
  git(path, "config", "user.name", "Test");
  writeFileSync(join(path, "README.md"), "initial\n");
  git(path, "add", "README.md");
  git(path, "commit", "-m", "initial");
}

describe("listWorktreeRows", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-wt-list-"));
    repo = join(root, "repo");
    initGitRepo(repo);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists retained worktrees, accurate base/upstream state, detached trees, and unchecked legacy branches", async () => {
    const remote = join(root, "origin.git");
    git(root, "clone", "--bare", repo, remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "fetch", "origin");
    git(root, "--git-dir", remote, "branch", "feat/pushed", "main");
    git(repo, "fetch", "origin");
    git(repo, "branch", "base-anchor");

    const pushedPath = join(root, "pushed workspace");
    const unpushedPath = join(root, "unpushed");
    const strandedPath = join(root, "stranded");
    const detachedPath = join(root, "detached");
    const checkedLegacyPath = join(root, "checked-legacy");
    git(repo, "worktree", "add", "-b", "feat/pushed", pushedPath, "main");
    git(pushedPath, "branch", "--set-upstream-to=origin/feat/pushed");
    git(repo, "worktree", "add", "-b", "feat/unpushed", unpushedPath, "main");
    writeFileSync(join(unpushedPath, "feature.txt"), "committed\n");
    git(unpushedPath, "add", "feature.txt");
    git(unpushedPath, "commit", "-m", "unpushed commit");
    git(unpushedPath, "branch", "--set-upstream-to=origin/main");
    writeFileSync(join(unpushedPath, "dirty.txt"), "uncommitted\n");
    git(repo, "worktree", "add", "-b", "pi/stranded", strandedPath, "main");
    writeFileSync(join(strandedPath, "stranded.txt"), "commit\n");
    git(strandedPath, "add", "stranded.txt");
    git(strandedPath, "commit", "-m", "stranded commit");
    writeFileSync(join(strandedPath, "dirty.txt"), "uncommitted\n");
    git(repo, "worktree", "add", "--detach", detachedPath, "main");
    git(repo, "worktree", "add", "-b", "pi-agent-checked", checkedLegacyPath, "main");
    git(repo, "branch", "pi-agent-orphan");
    writeFileSync(join(repo, "main-update.txt"), "advance default base\n");
    git(repo, "add", "main-update.txt");
    git(repo, "commit", "-m", "advance main");

    const rows = await listWorktreeRows(gitExec, repo, new Map([
      ["feat/unpushed", "base-anchor"],
      ["pi/stranded", "base-anchor"],
    ]));
    const byBranch = new Map(rows.map(row => [row.branch, row]));

    expect(rows).toHaveLength(6);
    expect(rows.some(row => row.kind === "worktree" && row.path === repo)).toBe(false);
    expect(byBranch.get("feat/pushed")).toMatchObject({
      kind: "worktree", dirty: false, baseRef: "main", ahead: 0, behind: 1,
      upstream: { branch: "origin/feat/pushed", ahead: 0, behind: 0, fullyPushed: true },
    });
    expect(byBranch.get("feat/unpushed")).toMatchObject({
      kind: "worktree", dirty: true, baseRef: "base-anchor", ahead: 1, behind: 0,
      upstream: { branch: "origin/main", ahead: 1, behind: 0, fullyPushed: false },
    });
    expect(byBranch.get("pi/stranded")).toMatchObject({
      kind: "worktree", dirty: true, baseRef: "base-anchor", ahead: 1, behind: 0, upstream: null,
    });
    expect(byBranch.get("(detached)")).toMatchObject({ kind: "worktree", branch: "(detached)" });
    expect(byBranch.get("pi-agent-checked")).toMatchObject({ kind: "worktree", branch: "pi-agent-checked" });
    expect(byBranch.get("pi-agent-orphan")).toEqual({
      kind: "legacy", branch: "pi-agent-orphan", path: "(not checked out)",
    });
  });
});

describe("/agents Worktrees view", () => {
  let hermetic: Hermetic;
  let worktreeRoot: string | undefined;

  afterEach(() => {
    if (worktreeRoot) rmSync(worktreeRoot, { recursive: true, force: true });
    worktreeRoot = undefined;
    vi.restoreAllMocks();
    hermetic?.restore();
  });

  it("shows branch, path, dirty state, base counts, and missing upstream without actions", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false, messaging: { enabled: false } } });
    initTheme(undefined, false);
    const repo = hermetic.dir;
    const pathRoot = mkdtempSync(join(tmpdir(), "pi-wt-menu-"));
    worktreeRoot = pathRoot;
    const worktree = join(pathRoot, "menu-worktree");
    initGitRepo(repo);
    const remote = join(pathRoot, "origin.git");
    git(pathRoot, "clone", "--bare", repo, remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "fetch", "origin");
    git(pathRoot, "--git-dir", remote, "branch", "feat/pushed", "main");
    git(repo, "fetch", "origin");
    git(repo, "worktree", "add", "-b", "pi/menu", worktree, "main");
    writeFileSync(join(worktree, "committed.txt"), "stranded work\n");
    git(worktree, "add", "committed.txt");
    git(worktree, "commit", "-m", "stranded commit");
    writeFileSync(join(worktree, "uncommitted.txt"), "dirty\n");
    const pushed = join(pathRoot, "pushed");
    git(repo, "worktree", "add", "-b", "feat/pushed", pushed, "main");
    git(pushed, "branch", "--set-upstream-to=origin/feat/pushed");
    const unpushed = join(pathRoot, "unpushed");
    git(repo, "worktree", "add", "-b", "feat/unpushed", unpushed, "main");
    git(unpushed, "branch", "--set-upstream-to=origin/main");
    writeFileSync(join(unpushed, "ahead.txt"), "one commit ahead\n");
    git(unpushed, "add", "ahead.txt");
    git(unpushed, "commit", "-m", "unpushed change");
    git(repo, "branch", "pi-agent-menu-legacy");

    const booted = makePi();
    vi.mocked(booted.pi.exec).mockImplementation((command: string, args: string[], options: { cwd?: string; timeout?: number }) =>
      gitExec(command, args, { cwd: options.cwd ?? repo, timeout: options.timeout ?? 5000 }));
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");

    let selected = false;
    let rendered = "";
    const select = vi.fn(async (_title: string, options: string[]) => {
      if (selected) return undefined;
      selected = true;
      return options.find(option => option === "Worktrees");
    });
    const custom = vi.fn(async (factory: (...args: unknown[]) => unknown) => {
      const component = factory(
        { terminal: { columns: 200, rows: 40 }, requestRender: () => {} },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        () => {},
      ) as { render(width: number): string[] };
      rendered = component.render(200).join("\n");
      return undefined;
    });
    const context = ctx({
      cwd: repo,
      ui: { notify: vi.fn(), select, custom },
    });

    await command.handler("", context);

    expect(select.mock.calls[0]?.[1]).toContain("Worktrees");
    expect(rendered).toContain("pi/menu");
    expect(rendered).toContain(worktree);
    expect(rendered).toContain("dirty yes");
    expect(rendered).toContain("1 ahead / 0 behind main");
    expect(rendered).toContain("no upstream");
    expect(rendered).toContain("pi-agent-menu-legacy · legacy");
    expect(rendered).toContain("origin/feat/pushed · fully pushed (0 ahead, 0 behind)");
    expect(rendered).toContain("origin/main · not fully pushed (1 ahead, 0 behind)");
    const commands = vi.mocked(booted.pi.exec).mock.calls.map(([, args]) => args.join(" "));
    expect(commands.some(args => /^(push|merge|rebase|worktree remove|branch -D)\b/.test(args))).toBe(false);
  });
});
