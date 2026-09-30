import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { loadSettings, readScopeSettings, saveSettingsPatch, settingsPath } from "../src/settings.js";

/**
 * The YAML contract: a hand-authored file keeps its comments, key order and
 * formatting through a save, a patch touches only its own keys, and a
 * pre-YAML `subagents.json` keeps working until the first save carries it over.
 */
describe("YAML settings file", () => {
  let userDir: string;
  let projectDir: string;
  let originalAgentDirEnv: string | undefined;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), "pi-yaml-user-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-yaml-project-"));
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = userDir;
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(userDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const userFile = () => settingsPath("user");
  const projectFile = () => settingsPath("project", projectDir);

  it("puts the layers at subagents.yaml, user under the agent dir and project under .pi", () => {
    expect(userFile()).toBe(join(userDir, "subagents.yaml"));
    expect(projectFile()).toBe(join(projectDir, ".pi", "subagents.yaml"));
  });

  it("keeps comments, key order and untouched keys across a save", () => {
    const handAuthored = [
      "# how many agents may run at once",
      "maxConcurrent: 4",
      "",
      "messaging:",
      "  enabled: true # peers may talk",
      "  directory: .mail",
      "",
      "showCost: false",
      "",
    ].join("\n");
    writeFileSync(projectFile(), handAuthored);

    saveSettingsPatch({ maxConcurrent: 9 }, "project", projectDir);

    const written = readFileSync(projectFile(), "utf-8");
    expect(written).toContain("# how many agents may run at once");
    expect(written).toContain("enabled: true # peers may talk");
    // Order is the author's: the patched key keeps its place, not the end.
    expect(written.indexOf("maxConcurrent")).toBeLessThan(written.indexOf("messaging"));
    expect(written.indexOf("messaging")).toBeLessThan(written.indexOf("showCost"));
    expect(parse(written)).toEqual({
      maxConcurrent: 9,
      messaging: { enabled: true, directory: ".mail" },
      showCost: false,
    });
  });

  it("merges one key into the messaging block without dropping its siblings", () => {
    writeFileSync(
      projectFile(),
      ["messaging:", "  enabled: true", "  surface: ui", "  maxHops: 4", ""].join("\n"),
    );

    saveSettingsPatch({ messaging: { surface: "context" } }, "project", projectDir);

    expect(readScopeSettings("project", projectDir).messaging).toEqual({
      enabled: true,
      surface: "context",
      maxHops: 4,
    });
  });

  it("merges the messaging block per key across layers, not wholesale", () => {
    writeFileSync(
      userFile(),
      ["messaging:", "  enabled: true", "  maxHops: 5", "  surface: ui", ""].join("\n"),
    );
    writeFileSync(projectFile(), ["messaging:", "  surface: context", ""].join("\n"));

    // A shallow spread would drop `enabled` and `maxHops` here, and the write
    // path merges per key — so the read has to merge per key too, or a save
    // would appear to lose settings it never touched.
    expect(loadSettings(projectDir).messaging).toEqual({
      enabled: true,
      maxHops: 5,
      surface: "context",
    });
  });

  it("overrides the worktree directory wholesale, because it is one setting", () => {
    writeFileSync(userFile(), "worktreeDirectory:\n  mode: custom\n  path: trees\n");
    writeFileSync(projectFile(), "worktreeDirectory:\n  mode: project\n");

    // `mode` and `path` describe one placement. Merging them per key would read
    // as a custom placement rooted at `trees` — a path the user never asked for
    // and that the mode would ignore anyway.
    expect(loadSettings(projectDir).worktreeDirectory).toEqual({ mode: "project" });
  });

  it("does not leak a patch from one layer into the other", () => {
    saveSettingsPatch({ maxConcurrent: 2 }, "project", projectDir);
    saveSettingsPatch({ showCost: true }, "user", projectDir);

    expect(readScopeSettings("project", projectDir)).toEqual({ maxConcurrent: 2 });
    expect(readScopeSettings("user", projectDir)).toEqual({ showCost: true });
    // The project layer still shadows the user one for the key it owns.
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 2, showCost: true });
  });

  it("writes numbers and booleans unquoted, so the sanitizer keeps them", () => {
    saveSettingsPatch({ maxConcurrent: 6, showCost: true, stallThresholdMinutes: 0 }, "project", projectDir);
    const written = readFileSync(projectFile(), "utf-8");
    expect(written).toContain("maxConcurrent: 6");
    expect(written).toContain("showCost: true");
    // 0 is the documented "disabled" marker and must survive as a number.
    expect(written).toContain("stallThresholdMinutes: 0");
    expect(loadSettings(projectDir).stallThresholdMinutes).toBe(0);
  });

  it("removes a key when the patch carries undefined for it", () => {
    saveSettingsPatch({ showCost: true, reportUsage: true }, "project", projectDir);
    saveSettingsPatch({ showCost: undefined }, "project", projectDir);

    expect(loadSettings(projectDir)).toEqual({ reportUsage: true });
    expect(readFileSync(projectFile(), "utf-8")).not.toContain("showCost");
  });

  it("deletes the node's own comment with the key, and leaves the others", () => {
    writeFileSync(projectFile(), ["# gone with the key", "showCost: true", "# stays", "showModel: true", ""].join("\n"));

    saveSettingsPatch({ showCost: undefined }, "project", projectDir);

    const written = readFileSync(projectFile(), "utf-8");
    expect(written).toContain("# stays");
    expect(written).not.toContain("gone with the key");
  });

  it("reads a deprecated subagents.json, and says so exactly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(projectDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 12 }));

    expect(loadSettings(projectDir).maxConcurrent).toBe(12);
    loadSettings(projectDir);

    const deprecations = warn.mock.calls.filter(call => /subagents\.json is deprecated/.test(String(call[0])));
    expect(deprecations).toHaveLength(1);
  });

  it("writes nothing while reading a deprecated json", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(projectDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 12 }));

    loadSettings(projectDir);

    // A read must not mutate the config directory: every process that boots the
    // extension would otherwise rewrite the user's files as a side effect.
    expect(existsSync(projectFile())).toBe(false);
  });

  it("carries the whole legacy layer over on the first save, not just the patched key", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      join(projectDir, ".pi", "subagents.json"),
      JSON.stringify({ maxConcurrent: 12, showCost: true, messaging: { enabled: false } }),
    );
    expect(loadSettings(projectDir).maxConcurrent).toBe(12);

    saveSettingsPatch({ maxConcurrent: 3 }, "project", projectDir);

    // The two settings the user never touched still exist, in YAML.
    expect(loadSettings(projectDir)).toEqual({
      maxConcurrent: 3,
      showCost: true,
      messaging: { enabled: false },
    });
  });

  it("prefers the yaml file once it exists, even with a json beside it", () => {
    writeFileSync(join(projectDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 12 }));
    writeFileSync(projectFile(), "maxConcurrent: 4\n");

    expect(loadSettings(projectDir).maxConcurrent).toBe(4);
  });

  it("reports malformed yaml and falls back to defaults instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(projectFile(), "maxConcurrent: [unclosed\n");

    expect(loadSettings(projectDir)).toEqual({});
    expect(String(warn.mock.calls[0][0])).toMatch(/Ignoring malformed settings/);
  });

  it("a save over a malformed file replaces it rather than appending to broken yaml", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(projectFile(), "maxConcurrent: [unclosed\n");

    saveSettingsPatch({ showCost: true }, "project", projectDir);

    expect(loadSettings(projectDir)).toEqual({ showCost: true });
  });
});
