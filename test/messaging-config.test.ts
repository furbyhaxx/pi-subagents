import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { AgentManagerDeliveryBridge } from "../src/messaging/delivery-bridge.js";
import type { AgentRow, MessagingSurface } from "../src/messaging/types.js";
import { loadSettings } from "../src/settings.js";
import { makePi } from "./helpers/boot-extension.js";

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

  it("reads the main message surface for each delivery", () => {
    let surface: MessagingSurface = "ui";
    const bridge = new AgentManagerDeliveryBridge({
      manager: new AgentManager(),
      pi: makePi().pi,
      mainAgentId: "main:s1",
      mainSessionId: "s1",
      mainSurface: () => surface,
    });
    const main: AgentRow = {
      agentId: "main:s1",
      type: "main",
      sessionId: "s1",
      kind: "main",
      status: "running",
      pid: process.pid,
      createdAt: 1,
      seenAt: 1,
    };

    expect(bridge.recipientInfo(main).surface).toBe("ui");
    surface = "context";
    expect(bridge.recipientInfo(main).surface).toBe("context");
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
        operatorTopicPrefix: "  human/  ",
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
      operatorTopicPrefix: "human/",
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
      messaging: { notifySocket: false, operatorTopicPrefix: "  " },
    }));
    expect(loadSettings(cwd).messaging).toEqual({ notifySocket: false });
  });
});
