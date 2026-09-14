import { initTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

function fakeSession() {
  return {
    messages: [],
    sessionManager: { getBranch: () => [] },
    subscribe: () => () => {},
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as AgentRecord["session"];
}

function record(id: string, description: string, startedAt: number): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description,
    status: "completed",
    toolUses: 2,
    startedAt,
    completedAt: startedAt + 1_000,
    session: fakeSession(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
}

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

let hermetic: Hermetic | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  hermetic?.restore();
  hermetic = undefined;
});

describe("/agents → Running agents", () => {
  it("sorts and displays starts newest-first, then restores the selected record cursor", async () => {
    hermetic = hermeticDir();
    initTheme(undefined, false);
    const oldAt = new Date(2025, 0, 2, 3, 4, 5).getTime();
    const middleAt = new Date(2025, 0, 2, 4, 5, 6).getTime();
    const newAt = new Date(2025, 0, 2, 5, 6, 7).getTime();
    const suffix = " inspect authentication middleware and permission boundaries across the project";
    const records = [
      record("old", `oldest${suffix}`, oldAt),
      record("new", `newest${suffix}`, newAt),
      record("middle", `chosen${suffix}`, middleAt),
    ];
    vi.spyOn(AgentManager.prototype, "listAgents").mockReturnValue(records);
    const selectItem = vi.spyOn(SettingsList.prototype, "selectItem");

    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");

    const pickerRenders: string[] = [];
    let pickedMenu = false;
    let customCall = 0;
    const context = ctx({
      ui: {
        notify: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          if (title !== "Agents" || pickedMenu) return undefined;
          pickedMenu = true;
          return options.find(option => option.startsWith("Running agents ("));
        }),
        custom: vi.fn(async (factory: (...args: unknown[]) => unknown) => {
          let result: unknown;
          const component = factory(
            { terminal: { rows: 40, columns: 180 }, requestRender: () => {} },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            {},
            (value: unknown) => { result = value; },
          ) as { handleInput?(data: string): void; render(width: number): string[] };
          const call = customCall++;
          if (call === 0) {
            pickerRenders.push(stripAnsi(component.render(55).join("\n")));
            component.handleInput?.("\x1b[B");
            component.handleInput?.("\r");
          } else if (call === 1) {
            component.handleInput?.("\x1b");
          } else {
            pickerRenders.push(stripAnsi(component.render(55).join("\n")));
            component.handleInput?.("\x1b");
          }
          return result;
        }),
      },
    });

    await command.handler("", context);

    const first = pickerRenders[0] ?? "";
    expect(first.indexOf("newest")).toBeLessThan(first.indexOf("chosen"));
    expect(first.indexOf("chosen")).toBeLessThan(first.indexOf("oldest"));
    expect(first).toContain("2025-01-02 05:06:07");
    expect(first).toContain("2025-01-02 04:05:06");
    expect(first).toContain("2025-01-02 03:04:05");
    expect(selectItem).toHaveBeenCalledWith("middle");
    expect(pickerRenders).toHaveLength(2);
  });
});
