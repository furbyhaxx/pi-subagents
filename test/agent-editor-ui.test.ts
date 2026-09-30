import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_FIELDS, readAgentFields } from "../src/agent-frontmatter.js";
import { type AgentScope, editAgentDefinition, type ModelOption } from "../src/ui/agent-editor.js";

/**
 * The definition editor's overlay, driven the way a terminal would: keys go in,
 * rendered lines come out, and what comes back is what the caller writes.
 */

const CTRL_S = "\u0013";
const ESC = "\u001b";
const ENTER = "\r";
const DOWN = "\u001b[B";
const TAB = "\t";

const MODELS: ModelOption[] = [
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "openai/gpt-5.1", name: "GPT-5.1", provider: "openai" },
];

const PROJECT_PATH = "/project/.pi/agents/reviewer.md";
const USER_PATH = "/home/u/.pi/agent/agents/reviewer.md";
const ORIGINAL = ["---", "description: Reviews diffs", "tools: read, grep", "---", "", "You review diffs.", ""].join("\n");

/**
 * Rows are `[...fields, prompt]`. One key per row: a terminal delivers an
 * escape sequence per press, and `matchesKey` reads a single sequence, so
 * concatenating them into one string would move the cursor once, not twice.
 */
const ROWS = [...AGENT_FIELDS.map(field => field.key), "__prompt__"];
const toRow = (key: string) => Array.from({ length: Math.max(0, ROWS.indexOf(key)) }, () => DOWN);

interface HarnessOptions {
  keys: string[];
  /**
   * Keys sent on every later overlay pass. Required: the screen is a loop, so
   * a test that does not say how the later passes end leaves the editor
   * re-opening its overlay forever.
   */
  repeat: string[];
  original?: string;
  answers?: (title: string, options: string[]) => string | undefined;
  editorText?: string;
}

function harness(options: HarnessOptions) {
  let lines: string[] = [];
  let pass = 0;
  const notify = vi.fn();
  const select = vi.fn(async (title: string, choices: string[]) =>
    (options.answers ?? ((_title: string, options: string[]) => options.find(choice => choice === "Discard and close")))(title, choices));

  const ctx = {
    cwd: process.cwd(),
    ui: {
      notify,
      select,
      confirm: vi.fn(async () => true),
      editor: vi.fn(async () => options.editorText),
      custom: vi.fn(async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => unknown) => {
        let result: unknown;
        const component = factory({ requestRender: () => {} }, {}, {}, (value: unknown) => { result = value; }) as {
          render(width: number): string[];
          invalidate(): void;
          handleInput(data: string): void;
        };
        const send = (data: string) => {
          component.handleInput(data);
          lines = component.render(80);
        };
        lines = component.render(80);
        for (const key of (pass++ === 0 ? options.keys : options.repeat)) {
          send(key);
          if (result !== undefined) break;
        }
        return result;
      }),
    },
  } as never;

  return {
    frame: () => lines.join("\n"),
    notify,
    select,
    run: () => editAgentDefinition({
      ctx,
      type: "reviewer",
      original: options.original ?? ORIGINAL,
      originalPath: PROJECT_PATH,
      initialScope: "project" as AgentScope,
      pathFor: (scope: AgentScope) => (scope === "user" ? USER_PATH : PROJECT_PATH),
      models: MODELS,
    }),
  };
}

describe("agent definition editor", () => {
  beforeAll(() => initTheme(undefined, false));
  it("renders a row per field, the save target and a clean status", async () => {
    const editor = harness({ keys: [ESC], repeat: [ESC] });
    const result = await editor.run();

    const frame = editor.frame();
    expect(frame).toContain("Agent · reviewer");
    expect(frame).toContain(PROJECT_PATH);
    expect(frame).toContain("no changes");
    expect(frame).toContain("Ctrl+S save");
    for (const label of ["Name", "Description", "Tools", "Models", "Thinking level", "System prompt"]) {
      expect(frame).toContain(label);
    }
    expect(result).toEqual({ action: "cancel" });
  });

  it("moves the save target with Tab and leaves the draft alone", async () => {
    const editor = harness({ keys: [TAB, ESC], repeat: [ESC] });
    await editor.run();

    expect(editor.frame()).toContain(USER_PATH);
  });

  it("edits a field through its own control and saves it on Ctrl+S", async () => {
    const editor = harness({
      keys: [...toRow("description"), ENTER, "!", ENTER, CTRL_S],
      repeat: [ESC],
    });
    const result = await editor.run();

    expect(result.action).toBe("save");
    if (result.action !== "save") return;
    expect(result.scope).toBe("project");
    expect(result.path).toBe(PROJECT_PATH);
    expect(readAgentFields(result.content).values.description).toBe("Reviews diffs!");
  });

  it("saves into the user scope once Tab retargets it", async () => {
    const editor = harness({ keys: [TAB, CTRL_S], repeat: [ESC] });
    const result = await editor.run();

    expect(result.action).toBe("save");
    if (result.action !== "save") return;
    expect(result.scope).toBe("user");
    expect(result.path).toBe(USER_PATH);
  });

  it("asks before leaving a dirty screen, and discards only on the word", async () => {
    let asked = 0;
    const editor = harness({
      keys: [...toRow("description"), ENTER, "!", ENTER, ESC],
      repeat: [ESC],
      // "Keep editing" first, so the screen is entered a second time; only the
      // second answer closes it.
      answers: (_title, choices) => (asked++ === 0 ? undefined : choices.find(choice => choice === "Discard and close")),
    });
    const result = await editor.run();

    expect(editor.select).toHaveBeenCalledWith("reviewer has unsaved changes", expect.anything());
    expect(asked).toBe(2);
    expect(result).toEqual({ action: "cancel" });
  });

  it("saves on the way out when that is what the user picks", async () => {
    const editor = harness({
      keys: [...toRow("description"), ENTER, "!", ENTER, ESC],
      repeat: [ESC],
      answers: (_title, choices) => choices.find(choice => choice === "Save and close"),
    });
    const result = await editor.run();

    expect(result.action).toBe("save");
    if (result.action !== "save") return;
    expect(readAgentFields(result.content).values.description).toBe("Reviews diffs!");
  });

  it("treats a save with nothing changed as no work", async () => {
    const editor = harness({ keys: [CTRL_S], repeat: [ESC] });
    const result = await editor.run();

    expect(result).toEqual({ action: "cancel" });
    expect(editor.notify).not.toHaveBeenCalled();
  });

  it("writes a model picked from the fuzzy list as a candidate list", async () => {
    const editor = harness({
      // The picker's first row is "inherit parent", so one down reaches Sonnet.
      keys: [...toRow("models"), ENTER, DOWN, ENTER, CTRL_S],
      repeat: [ESC],
    });
    const result = await editor.run();

    expect(result.action).toBe("save");
    if (result.action !== "save") return;
    expect(readAgentFields(result.content).values.models).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("cycles a boolean through its chooser and writes the key", async () => {
    const editor = harness({
      // `enabled` is absent, so the chooser opens on "default" and one down is
      // "on".
      keys: [...toRow("enabled"), ENTER, DOWN, ENTER, CTRL_S],
      repeat: [ESC],
    });
    const result = await editor.run();

    expect(result.action).toBe("save");
    if (result.action !== "save") return;
    expect(readAgentFields(result.content).values.enabled).toBe(true);
  });

  it("hands the prompt body to the inline editor, with no frontmatter in it", async () => {
    const editor = harness({
      keys: [...toRow("__prompt__"), ENTER, ENTER],
      repeat: [CTRL_S],
      editorText: "You review diffs, carefully.",
    });
    const result = await editor.run();

    expect(result.action).toBe("save");
    if (result.action !== "save") return;
    const reread = readAgentFields(result.content);
    expect(reread.body).toBe("You review diffs, carefully.");
    expect(reread.values.description).toBe("Reviews diffs");
  });
});
