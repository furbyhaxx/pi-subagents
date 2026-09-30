import { existsSync, readFileSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
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

/** Ctrl+S and Esc as a legacy terminal sends them. */
const CTRL_S = "\u0013";
const ESC = "\u001b";

interface ScreenPass {
  /** Keys to send while the settings list is up. */
  keys: (list: SettingsList, send: (data: string) => void) => void;
}

/**
 * Boot the extension, open `/agents → Settings`, and drive the overlay through
 * the given passes. The screen is a loop since saving became explicit, so a
 * test says what to do on each pass rather than assuming one render.
 */
async function driveSettings(passes: ScreenPass[]): Promise<{ notify: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> }> {
  const listInput = vi.spyOn(SettingsList.prototype, "handleInput");
  const booted = makePi();
  subagentsExtension(booted.pi);
  const command = booted.commands.get("agents");
  if (!command) throw new Error("the extension did not register /agents");

  let openedSettings = false;
  let pass = 0;
  const notify = vi.fn();
  const select = vi.fn(async (title: string, options: string[]) => {
    if (title === "Unsaved settings" || title === "has unsaved changes") return undefined;
    if (title !== "Agents" || openedSettings) return undefined;
    openedSettings = true;
    return options.find(option => option === "Settings");
  });

  const context = ctx();
  context.ui = {
    ...context.ui,
    notify,
    select,
    custom: vi.fn(async (factory: (...args: unknown[]) => unknown) => {
      let result: unknown;
      const component = factory(
        { requestRender: () => {} },
        {},
        {},
        (value: unknown) => { result = value; },
      ) as { handleInput?(data: string): void };
      const send = (data: string) => component.handleInput?.(data);
      // The list is only reachable through the handleInput spy, which records an
      // instance when a key reaches it — so one benign key goes first.
      send("x");
      const list = listInput.mock.instances.at(-1);
      if (!list) throw new Error("the settings list was not constructed");
      const step = passes[Math.min(pass++, passes.length - 1)];
      step.keys(list as SettingsList, send);
      return result;
    }),
    input: vi.fn(async () => undefined),
  };

  await command.handler("", context);
  return { notify, select };
}

describe("/agents → Settings messaging rows", () => {
  it("saves only the changed keys, into the user layer, leaving the project file alone", async () => {
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

    await driveSettings([
      {
        keys: (list, send) => {
          list.selectItem("messagingEnabled");
          send(" ");
          list.selectItem("messagingSurface");
          send(" ");
          send(CTRL_S);
        },
      },
      { keys: (_list, send) => send(ESC) },
    ]);

    // The default scope is the user layer, so that is what the menu wrote — and
    // only the two rows it was told to change.
    const userSettings = parse(
      readFileSync(`${hermetic.agentDir}/subagents.yaml`, "utf-8"),
    ) as { messaging: Record<string, unknown> };
    expect(userSettings.messaging).toEqual({ enabled: false, surface: "context" });

    // The project layer is a separate file, and a patch cannot reach into it.
    const projectSettings = parse(
      readFileSync(`${hermetic.dir}/.pi/subagents.yaml`, "utf-8"),
    ) as { messaging: Record<string, unknown> };
    expect(projectSettings.messaging).toEqual({
      enabled: true,
      surface: "ui",
      directory: ".mail",
      operatorTopicPrefix: "human/",
    });
  });

  it("stages instead of applying: leaving a dirty screen writes nothing", async () => {
    hermetic = hermeticDir({ settings: { showCost: false } });
    initTheme(undefined, false);

    const { select } = await driveSettings([
      {
        keys: (list, send) => {
          list.selectItem("showCost");
          send(" ");
          send(ESC);
        },
      },
    ]);

    // Backing out asked first, and the mock's `select` declined — so the screen
    // stayed open, the second pass left it, and nothing was ever written. The
    // user layer does not even exist: the staged change never left the draft.
    expect(select).toHaveBeenCalledWith("Unsaved settings", expect.anything());
    expect(existsSync(`${hermetic.agentDir}/subagents.yaml`)).toBe(false);
  });

  it("saves on the explicit save key", async () => {
    hermetic = hermeticDir({ settings: { showCost: false } });
    initTheme(undefined, false);

    const { notify } = await driveSettings([
      {
        keys: (list, send) => {
          list.selectItem("showCost");
          send(" ");
          send(CTRL_S);
        },
      },
      { keys: (_list, send) => send(ESC) },
    ]);

    expect(parse(readFileSync(`${hermetic.agentDir}/subagents.yaml`, "utf-8"))).toEqual({ showCost: true });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("saved to"), "info");
  });
});
