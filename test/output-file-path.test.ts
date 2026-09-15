// Persistent transcripts live under an extension-owned, owner-only session root.
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOutputFilePath, sessionArtifactRoot, setSessionArtifactDirectory } from "../src/output-file.js";

const AGENT = "agent-xyz";
const SESSION = "session-123";

describe("createOutputFilePath", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-outpath-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    // Sandboxed: an inherited session root would move the default container.
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
    setSessionArtifactDirectory(undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds <agent-dir>/sessions/<project-key>/<session>/tasks/<agent>.output", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(path).toBe(join(sessionArtifactRoot("/home/user/project", SESSION), "tasks", `${AGENT}.output`));
    expect(path.startsWith(join(dir, "sessions", "project-"))).toBe(true);
  });

  it("defaults to <session-root>/subagents without touching the agent dir", () => {
    const sessionRoot = join(dir, "env-sessions");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", sessionRoot);
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(sessionArtifactRoot("/home/user/project", SESSION).startsWith(join(sessionRoot, "subagents", "project-"))).toBe(true);
    expect(path.startsWith(join(sessionRoot, "subagents"))).toBe(true);
    expect(existsSync(dirname(path))).toBe(true);
    expect(existsSync(join(dir, "sessions"))).toBe(false);
  });

  it("treats an empty session root as unset", () => {
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(path.startsWith(join(dir, "sessions", "project-"))).toBe(true);
  });

  it("creates the directory chain so the first write cannot fail", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(existsSync(dirname(path))).toBe(true);
    expect(statSync(dirname(path)).isDirectory()).toBe(true);
  });

  it("separates projects with the same basename", () => {
    const a = createOutputFilePath("/home/user/project", AGENT, SESSION);
    const b = createOutputFilePath("/home/other/project", AGENT, SESSION);
    expect(a).not.toBe(b);
  });

  it.skipIf(process.platform === "win32")("creates all extension-owned directories owner-only", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    for (const owned of [dirname(path), dirname(dirname(path)), dirname(dirname(dirname(path)))]) {
      expect(statSync(owned).mode & 0o777).toBe(0o700);
    }
  });

  it.skipIf(process.platform === "win32")("re-tightens a pre-existing world-readable session root", () => {
    const root = sessionArtifactRoot("/home/user/project", SESSION);
    chmodSync(root, 0o755);
    expect(statSync(root).mode & 0o777).toBe(0o755);
    createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });
});
