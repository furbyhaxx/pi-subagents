import { readFileSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  hermetic?.restore();
  hermetic = undefined;
});

describe("/agents → Settings stall threshold", () => {
  it("surfaces the numeric threshold and persists a live change", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    initTheme(undefined, false);
    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");

    let openedSettings = false;
    let settingsViews = 0;
    const context = ctx({ cwd: hermetic.dir });
    context.ui = {
      ...context.ui,
      notify: vi.fn(),
      select: vi.fn(async (title: string, options: string[]) => {
        if (title !== "Agents" || openedSettings) return undefined;
        openedSettings = true;
        return options.find(option => option === "Settings");
      }),
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown) => {
        let result: unknown;
        const component = factory(
          { requestRender: () => {} },
          {},
          {},
          (value: unknown) => { result = value; },
        ) as { handleInput?(data: string): void };
        component.handleInput?.("x");
        if (settingsViews++ === 0) {
          component.handleInput?.("\x1b[B");
          component.handleInput?.("\x1b[B");
          component.handleInput?.("\r");
        } else {
          component.handleInput?.("\x1b");
        }
        return result;
      }),
      input: vi.fn(async (label: string, current: string) => {
        expect(label).toContain("Stall threshold");
        expect(current).toBe("5");
        return "0";
      }),
    };

    await command.handler("", context);

    const saved = JSON.parse(readFileSync(`${hermetic.dir}/.pi/subagents.json`, "utf-8")) as Record<string, unknown>;
    expect(saved.stallThresholdMinutes).toBe(0);
    expect(context.ui.notify).toHaveBeenCalledWith("Stall visibility disabled", "info");
  });
});
