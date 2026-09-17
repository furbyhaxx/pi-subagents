import { readFileSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
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

describe("/agents → Settings messaging rows", () => {
  it("persists both choices without erasing file-only messaging settings", async () => {
    hermetic = hermeticDir({
      settings: {
        messaging: {
          enabled: true,
          surface: "ui",
          directory: ".mail",
          operatorTopicPrefix: "human/",
        },
      },
    });
    initTheme(undefined, false);
    const listInput = vi.spyOn(SettingsList.prototype, "handleInput");
    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");

    let openedSettings = false;
    const context = ctx();
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
        const list = listInput.mock.instances.at(-1);
        if (!list) throw new Error("the settings list was not constructed");
        list.selectItem("messagingEnabled");
        component.handleInput?.(" ");
        list.selectItem("messagingSurface");
        component.handleInput?.(" ");
        component.handleInput?.("\x1b");
        return result;
      }),
      input: vi.fn(async () => undefined),
    };

    await command.handler("", context);

    const saved = JSON.parse(
      readFileSync(`${hermetic.dir}/.pi/subagents.json`, "utf-8"),
    ) as { messaging: Record<string, unknown> };
    expect(saved.messaging).toMatchObject({
      enabled: false,
      surface: "context",
      directory: ".mail",
      operatorTopicPrefix: "human/",
    });
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Peer messaging disabled. Takes effect on next pi session.",
      "info",
    );
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Message surface set to context. Applies immediately.",
      "info",
    );
  });
});
