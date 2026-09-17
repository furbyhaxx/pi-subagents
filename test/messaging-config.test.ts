import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCustomAgents } from "../src/custom-agents.js";
import { loadSettings } from "../src/settings.js";

describe("messaging configuration", () => {
  const directories: string[] = [];
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  it("parses the per-agent messaging_surface override", () => {
    const cwd = mkdtempSync(join(tmpdir(), "messaging-frontmatter-"));
    directories.push(cwd);
    const dir = join(cwd, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "listener.md"), "---\ndescription: Listener\nmessaging_surface: context\n---\nListen.\n");

    expect(loadCustomAgents(cwd).get("listener")?.messagingSurface).toBe("context");
  });

  it("sanitizes every Phase 2 messaging setting", () => {
    const cwd = mkdtempSync(join(tmpdir(), "messaging-settings-"));
    const agentDir = mkdtempSync(join(tmpdir(), "messaging-agent-home-"));
    directories.push(cwd, agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
      messaging: {
        enabled: false,
        scope: "session",
        directory: ".mail",
        notifySocket: ".mail/notify.sock",
        maxWakesPerMinute: 3,
        maxHops: 2,
        messageTtlMs: 1234,
        maxWaitMs: 4321,
        mailboxLimit: 12,
        surface: "off",
        allowForeignMainWake: false,
      },
    }));

    expect(loadSettings(cwd).messaging).toEqual({
      enabled: false,
      scope: "session",
      directory: ".mail",
      notifySocket: ".mail/notify.sock",
      maxWakesPerMinute: 3,
      maxHops: 2,
      messageTtlMs: 1234,
      maxWaitMs: 4321,
      mailboxLimit: 12,
      surface: "off",
      allowForeignMainWake: false,
    });

    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
      messaging: { notifySocket: false },
    }));
    expect(loadSettings(cwd).messaging).toEqual({ notifySocket: false });
  });
});
