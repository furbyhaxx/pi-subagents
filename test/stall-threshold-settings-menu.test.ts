import { readFileSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
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
  it("stages the typed threshold and writes it on save", async () => {
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
        // Three passes: open the numeric prompt, save what it returned, then
        // leave — the screen stays open after a save.
        const pass = settingsViews++;
        if (pass === 0) {
          component.handleInput?.("\x1b[B");
          component.handleInput?.("\x1b[B");
          component.handleInput?.("\r"); // Enter on the numeric row → prompt
        } else if (pass === 1) {
          component.handleInput?.("\x13"); // Ctrl+S
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

    // The menu saves to the user layer by default, and only the staged key.
    const saved = parse(readFileSync(`${hermetic.agentDir}/subagents.yaml`, "utf-8")) as Record<string, unknown>;
    expect(saved.stallThresholdMinutes).toBe(0);
    // One toast for the save, naming the message and the file it landed in.
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Stall visibility disabled"),
      "info",
    );
  });

  it("re-asks rather than staging a number the settings file would drop", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    initTheme(undefined, false);
    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");

    let openedSettings = false;
    let settingsViews = 0;
    const typed: string[] = [];
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
        const pass = settingsViews++;
        if (pass === 0) {
          component.handleInput?.("\x1b[B");
          component.handleInput?.("\x1b[B");
          component.handleInput?.("\r");
        } else if (pass === 1) {
          component.handleInput?.("\x13");
        } else {
          component.handleInput?.("\x1b");
        }
        return result;
      }),
      // First a value the row cannot hold, then a usable one. `-1` would be
      // dropped by sanitize on the way back in, so accepting it would produce
      // a save that reports success and persists nothing.
      input: vi.fn(async (label: string) => {
        expect(label).toContain("Stall threshold");
        typed.push("pending");
        return typed.length === 1 ? "-1" : "0";
      }),
    };

    await command.handler("", context);

    expect(typed).toHaveLength(2);
    const saved = parse(readFileSync(`${hermetic.agentDir}/subagents.yaml`, "utf-8")) as Record<string, unknown>;
    expect(saved.stallThresholdMinutes).toBe(0);
    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Stall visibility disabled"),
      "info",
    );
  });
});
