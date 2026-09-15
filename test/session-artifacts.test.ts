import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { createOutputFilePath, getWorktreeDirectory, sessionArtifactRoot, sessionTaskDir, setSessionArtifactDirectory, setWorktreeDirectory } from "../src/output-file.js";
import { applySettings, loadSettings, type SettingsAppliers, saveSettings } from "../src/settings.js";

describe("persistent session artifacts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-artifacts-test-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
    // Sandboxed: an inherited session root would move the default container.
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
    setSessionArtifactDirectory(undefined);
    setWorktreeDirectory({ mode: "session" });
  });
  afterEach(() => {
    setSessionArtifactDirectory(undefined);
    setWorktreeDirectory({ mode: "session" });
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the pi agent directory and collision-resistant project identity", () => {
    const root = sessionArtifactRoot(join(dir, "a-b", "c"), "root-session");
    expect(root.startsWith(join(dir, "agent", "sessions"))).toBe(true);
    expect(root).not.toBe(sessionArtifactRoot(join(dir, "a", "b-c"), "root-session"));
    expect(dirname(sessionTaskDir(dir, "root-session", root))).toBe(root);
    if (process.platform !== "win32") expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("keeps an explicit artifact directory ahead of the session-root override", () => {
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(dir, "env-sessions"));
    setSessionArtifactDirectory(join(dir, "explicit"));
    const root = sessionArtifactRoot(join(dir, "origin"), "session");
    expect(root.startsWith(join(dir, "explicit"))).toBe(true);
  });

  it("anchors relative settings to origin and preserves explicit roots after settings change", () => {
    const origin = join(dir, "origin");
    setSessionArtifactDirectory("artifacts");
    const root = sessionArtifactRoot(origin, "session");
    expect(root.startsWith(join(origin, "artifacts"))).toBe(true);
    const output = createOutputFilePath(origin, "child", "session", root);
    const journal = join(sessionTaskDir(origin, "session", root), "run.workflow.jsonl");
    writeFileSync(output, "transcript");
    writeFileSync(journal, "journal");
    setSessionArtifactDirectory(join(dir, "different"));
    expect(createOutputFilePath("/nested/worktree", "child", "session", root)).toBe(output);
    expect(readFileSync(output, "utf8")).toBe("transcript");
    expect(readFileSync(journal, "utf8")).toBe("journal");
    expect(sessionArtifactRoot(origin, "new-session").startsWith(join(dir, "different"))).toBe(true);
  });

  it("anchors a relative session root to the process cwd and reuses the recorded absolute root", () => {
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "relative-sessions");
    const origin = join(dir, "origin");
    const restore = process.cwd();
    process.chdir(dir);
    try {
      const cwd = process.cwd();
      const root = sessionArtifactRoot(origin, "session");
      expect(isAbsolute(root)).toBe(true);
      expect(root.startsWith(join(cwd, "relative-sessions", "subagents"))).toBe(true);
      expect(sessionArtifactRoot(origin, "session")).toBe(root);
      // A persisted binding replays the recorded root from any cwd.
      const output = createOutputFilePath(cwd, "child", "session", root);
      expect(output).toBe(join(root, "tasks", "child.output"));
      expect(createOutputFilePath("/nested/worktree", "child", "session", root)).toBe(output);
    } finally {
      process.chdir(restore);
    }
  });

  it("fails rather than falling back when persistent storage cannot be created", () => {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");
    setSessionArtifactDirectory(blocked);
    expect(() => sessionArtifactRoot(dir, "session")).toThrow();
  });

  it("round-trips atomic placement settings and applies both storage hooks", () => {
    saveSettings({ sessionArtifactDirectory: "artifacts", worktreeDirectory: { mode: "custom", path: "trees" } }, dir);
    const loaded = loadSettings(dir);
    expect(loaded).toMatchObject({ sessionArtifactDirectory: "artifacts", worktreeDirectory: { mode: "custom", path: "trees" } });
    const appliers = { setSessionArtifactDirectory, setWorktreeDirectory } as SettingsAppliers;
    applySettings(loaded, appliers);
    expect(getWorktreeDirectory()).toEqual({ mode: "custom", path: "trees" });
    for (const mode of ["session", "project"] as const) {
      saveSettings({ ...loaded, worktreeDirectory: { mode }, showCost: true }, dir);
      expect(loadSettings(dir).worktreeDirectory).toEqual({ mode });
    }
  });

  it.each([false, true])("binds relative storage at the origin root and restores it on restart (separate Git directory: %s)", async (separateGitDir) => {
    const launchCwd = separateGitDir ? join(dir, "packages", "api") : dir;
    if (separateGitDir) {
      execFileSync("git", ["init", "--quiet", "--separate-git-dir", join(dir, "git-metadata"), dir]);
      mkdirSync(launchCwd, { recursive: true });
    }
    saveSettings({ schedulingEnabled: false, workflowsEnabled: false, sessionArtifactDirectory: "first" }, launchCwd);
    const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
    const ctx = {
      cwd: launchCwd, hasUI: false, mode: "print", ui: {},
      sessionManager: { getSessionId: () => "session", getEntries: () => entries },
    } as unknown as ExtensionContext;
    const start = async () => {
      const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
      const pi = {
        on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => hooks.set(name, handler),
        registerMessageRenderer: vi.fn(), registerEntryRenderer: vi.fn(), registerFlag: vi.fn(),
        registerTool: vi.fn(), registerCommand: vi.fn(), getFlag: vi.fn(),
        getAllTools: () => [], getActiveTools: () => [],
        events: { emit: vi.fn(), on: () => () => {} },
        appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
        exec: async (command: string, args: string[], options: { cwd: string }) => ({
          code: 0, killed: false, stderr: "",
          stdout: separateGitDir ? execFileSync(command, args, { cwd: options.cwd, encoding: "utf8" }) : join(dir, ".git"),
        }),
      } as unknown as ExtensionAPI;
      const cwd = process.cwd();
      process.chdir(launchCwd);
      try { extension(pi); } finally { process.chdir(cwd); }
      await hooks.get("session_start")?.({}, ctx);
      return async () => { await hooks.get("session_shutdown")?.({}, ctx); };
    };
    let shutdown = await start();
    const binding = entries.find(e => e.customType === "subagents:artifacts")!.data as { artifactRoot: string; originCwd: string };
    expect(realpathSync(binding.originCwd)).toBe(realpathSync(dir));
    expect(binding.artifactRoot.startsWith(join(binding.originCwd, "first"))).toBe(true);
    const output = createOutputFilePath(dir, "child", "session", binding.artifactRoot);
    writeFileSync(output, "keep");
    await shutdown();
    saveSettings({ schedulingEnabled: false, workflowsEnabled: false, sessionArtifactDirectory: join(dir, "second") }, launchCwd);
    shutdown = await start();
    expect(entries.filter(e => e.customType === "subagents:artifacts")).toHaveLength(1);
    expect(readFileSync(output, "utf8")).toBe("keep");
    await shutdown();
    ctx.sessionManager.getSessionId = () => "new-session";
    shutdown = await start();
    const next = entries.filter(e => e.customType === "subagents:artifacts").at(-1)!.data as { artifactRoot: string };
    expect(next.artifactRoot.startsWith(join(dir, "second"))).toBe(true);
    expect(existsSync(output)).toBe(true);
    await shutdown();
  });
});
