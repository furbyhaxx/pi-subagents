/**
 * agent-editor.ts — the `/agents → Edit` form.
 *
 * One row per frontmatter field, driven by `AGENT_FIELDS`, plus a row for the
 * prompt body. Nothing here is free-text YAML: the frontmatter is reached only
 * through typed inputs and choosers, because a mistyped key or a stray quote
 * makes the file unloadable, and the only symptom is an agent that silently
 * stops existing.
 *
 * Keys, deliberately not the ones a plain list would take:
 *   - `Tab`    moves the save target between the project and the user scope.
 *              The draft is untouched — only where it lands changes.
 *   - `Ctrl+S` saves. There is no implicit save, and `Esc` out of a dirty form
 *              asks before discarding.
 *   - `Enter`  opens the field's own control (input, chooser, fuzzy model
 *              picker, prompt editor). The list itself never writes a value.
 *
 * The prompt body is edited either inline or in the configured external editor.
 * Both paths hand over the BODY ONLY — the frontmatter is not in that buffer,
 * so an external-editor session cannot produce an unparseable file.
 */

import { existsSync, readFileSync } from "node:fs";
import { type ExtensionCommandContext, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, matchesKey, type SelectItem, SelectList, type SettingItem, SettingsList, Spacer, Text, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AGENT_COLOR_NAMES } from "../agent-color.js";
import { AGENT_FIELDS, type AgentFieldSpec, type AgentFieldValue, type AgentFieldValues, applyAgentFields, readAgentFields } from "../agent-frontmatter.js";
import { editInExternalEditor, resolveExternalEditor } from "../prompt-editor.js";

/** Where a saved agent file goes. The workspace scope is read-only, so it is not a target. */
export type AgentScope = "project" | "user";

export interface ModelOption {
  /** Canonical `provider/modelId` written into the frontmatter. */
  id: string;
  name: string;
  provider: string;
}

export interface AgentEditorOptions {
  ctx: ExtensionCommandContext;
  /** The agent type, shown in the header. */
  type: string;
  /** File content the editor started from; "" for an agent that has no file yet. */
  original: string;
  /** The file `original` came from, so a no-op save is not mistaken for a write. */
  originalPath?: string;
  /** Absolute path a save at this scope writes to. */
  pathFor: (scope: AgentScope) => string;
  /** Scope the file in `original` lives in, or where a new one belongs. */
  initialScope: AgentScope;
  /** Registry models, for the picker. */
  models: readonly ModelOption[];
}

export type AgentEditorResult =
  | { action: "save"; scope: AgentScope; path: string; content: string }
  | { action: "cancel" };

/** What the overlay asks its caller to do once it is out of the way. */
type EditorAction =
  | { kind: "save" }
  | { kind: "back" }
  | { kind: "prompt-inline" }
  | { kind: "prompt-external"; command: string };

const PROMPT_ROW = "__prompt__";
const UNSET = "__unset__";
const CUSTOM = "__custom__";
const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];
const RIGHT = "\u001b[C";
const PROMPT_HINT = "Instructions this agent runs on. Opened here or in your external editor; the frontmatter is never part of that buffer.";

interface Control {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
}

interface EditorState {
  scope: AgentScope;
  values: AgentFieldValues;
  body: string;
  selected: number;
}

/**
 * Run the editor to completion. Owns the overlay loop, so the caller only sees
 * the final result — including after an external editor, which needs the
 * overlay closed before the child process can take the terminal.
 */
export async function editAgentDefinition(options: AgentEditorOptions): Promise<AgentEditorResult> {
  const { ctx } = options;
  const loaded = readAgentFields(options.original);
  const state: EditorState = {
    scope: options.initialScope,
    values: loaded.values,
    body: loaded.body,
    selected: 0,
  };
  // A copy, not the same object: the dirty markers compare each field against
  // what the editor started from, and an alias would make every comparison
  // vacuously true — no `*` on a changed row, and a footer that never counts.
  const baseline = { values: { ...loaded.values }, body: loaded.body };
  const serialize = () => applyAgentFields(options.original, state.values, state.body);
  const isDirty = () => serialize() !== options.original;

  // Captured on first render: the external editor needs the same TUI pi hands
  // its own editor flow, to stop the renderer while the child owns the terminal.
  let tui: TUI | undefined;

  const saveTo = async (): Promise<AgentEditorResult | undefined> => {
    const path = options.pathFor(state.scope);
    const content = serialize();
    // Nothing changed and the target is the file we started from: no write to
    // make, so nothing to report.
    if (content === options.original && path === options.originalPath) return { action: "cancel" };
    if (!(await confirmOverwrite(ctx, path, options.original))) return undefined;
    return { action: "save", scope: state.scope, path, content };
  };

  while (true) {
    let action: EditorAction | undefined;
    await ctx.ui.custom<EditorAction>(
      (rendered, _theme, _kb, done) => {
        tui = rendered;
        return createEditorView(state, baseline, options, next => {
          action = next;
          done(next);
        });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } },
    );
    // The factory always runs before the overlay resolves, so this only covers
    // a host that closes the overlay without calling `done`.
    action ??= { kind: "back" };

    if (action.kind === "prompt-inline") {
      const edited = await ctx.ui.editor(`System prompt — ${options.type}`, state.body);
      if (edited !== undefined) state.body = edited.trim();
      continue;
    }
    if (action.kind === "prompt-external") {
      if (!tui) {
        ctx.ui.notify("No interactive terminal here for an external editor.", "warning");
        continue;
      }
      const result = await editInExternalEditor(tui, action.command, state.body);
      if (result.status === "edited") state.body = result.content.trim();
      else ctx.ui.notify(`${action.command} exited without saving.`, "info");
      continue;
    }
    if (action.kind === "save") {
      const saved = await saveTo();
      if (saved) return saved;
      continue;
    }
    if (!isDirty()) return { action: "cancel" };
    const choice = await ctx.ui.select(`${options.type} has unsaved changes`, [
      "Save and close",
      "Discard and close",
      "Keep editing",
    ]);
    if (choice === "Save and close") {
      const saved = await saveTo();
      if (saved) return saved;
      continue;
    }
    if (choice === "Discard and close") return { action: "cancel" };
  }
}

/**
 * Confirm before writing over a file the editor did not start from.
 *
 * A scope switch is the case that matters: the draft is shared, so saving
 * after `Tab` writes the same content into the other scope, replacing whatever
 * that agent file says there. On the file we loaded from, a difference means
 * something wrote to it mid-edit, which is worth a prompt too.
 */
async function confirmOverwrite(ctx: ExtensionCommandContext, path: string, original: string): Promise<boolean> {
  if (!existsSync(path)) return true;
  let current: string;
  try {
    current = readFileSync(path, "utf-8");
  } catch {
    return true;
  }
  if (current === original) return true;
  return ctx.ui.confirm("Overwrite", `${path} already has different content. Overwrite it?`);
}

/** The overlay: a header naming the save target, the field rows, any open control. */
function createEditorView(
  state: EditorState,
  baseline: { values: AgentFieldValues; body: string },
  options: AgentEditorOptions,
  act: (action: EditorAction) => void,
): Control {
  const theme = getSettingsListTheme();
  const rows: string[] = [...AGENT_FIELDS.map(field => field.key), PROMPT_ROW];
  let control: Control | undefined;

  const rowChanged = (key: string) =>
    key === PROMPT_ROW ? state.body !== baseline.body : state.values[key] !== baseline.values[key];
  const touchedCount = () => rows.filter(rowChanged).length;
  /**
   * Whether a save would change the file — the same question `Esc` asks.
   *
   * Not the row count: a file that a save would rewrite without the user
   * touching anything (a singular `model:`, a missing blank line) is dirty by
   * this measure and clean by the row count, and the two answers have to
   * agree or the footer promises a quiet exit that then asks to save.
   */
  const isDirty = () => applyAgentFields(options.original, state.values, state.body) !== options.original;

  /** Set a field. `undefined` is a real value here: it means "key absent". */
  const setValue = (key: string, value: AgentFieldValue) => {
    if (key !== PROMPT_ROW) state.values[key] = value;
  };

  function chooser(title: string, items: SelectItem[], currentValue: string, onPick: (value: string) => void): Control {
    const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
    list.onSelect = item => onPick(item.value);
    list.onCancel = () => {
      control = undefined;
    };
    const index = items.findIndex(item => item.value === currentValue);
    if (index >= 0) list.setSelectedIndex(index);
    const container = new Container();
    container.addChild(new Text(`${title} — Enter to pick, Esc to cancel`, 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => list.handleInput?.(data),
    };
  }

  /**
   * Single-line text entry. `commit` returns true to close, or the reason it
   * refused, which is rendered under the input rather than thrown away.
   */
  function textInput(
    heading: string,
    hint: string,
    initial: string,
    commit: (text: string) => true | string,
    onCancel: () => void,
  ): Control {
    const field = new Input();
    field.setValue(initial);
    // `setValue` leaves the cursor at 0, so the first keystroke would land in
    // front of the existing value. There is no cursor-to-end binding on Input,
    // so walk it there the way a terminal would.
    for (let i = 0; i < initial.length; i++) field.handleInput(RIGHT);
    let error = "";
    field.onSubmit = (text) => {
      const result = commit(text);
      if (result === true) {
        control = undefined;
        return;
      }
      error = result;
    };
    field.onEscape = () => {
      error = "";
      onCancel();
    };
    const container = new Container();
    container.addChild(new Text(`${heading} — Enter to save, Esc to cancel`, 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(field);
    return {
      render(width: number) {
        return [...container.render(width), "", theme.hint(hint), ...(error ? [theme.hint(error)] : [])];
      },
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => field.handleInput(data),
    };
  }

  /** Fuzzy model picker: type to narrow, Enter to pick, Esc to cancel. */
  function modelPicker(field: AgentFieldSpec, value: AgentFieldValue): Control {
    const items: SettingItem[] = [
      { id: UNSET, label: "Inherit the parent's model", currentValue: "default", values: ["default"] },
      ...options.models.map(model => ({
        id: model.id,
        label: `${model.name}  ${model.id}`,
        currentValue: model.id,
        values: [model.id],
      })),
    ];
    // A configured model can be missing from the registry — an uninstalled
    // provider, a renamed id. Keeping it selectable stops a save from dropping
    // a line the user wrote by hand.
    for (const configured of Array.isArray(value) ? value : []) {
      if (items.some(item => item.id === configured)) continue;
      items.push({ id: configured, label: `${configured}  (unavailable)`, currentValue: configured, values: [configured] });
    }
    const list = new SettingsList(items, 12, theme, id => {
      control = undefined;
      setValue(field.key, id === UNSET ? undefined : [id]);
    }, () => {
      control = undefined;
    }, { enableSearch: true });
    const container = new Container();
    container.addChild(new Text(`${field.label} — type to search, Enter to pick, Esc to cancel`, 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => list.handleInput?.(data),
    };
  }

  function promptControl(): Control {
    const editor = resolveExternalEditor();
    const items: SelectItem[] = [{ value: "inline", label: "Edit inline" }];
    if (editor) items.push({ value: "external", label: `Edit in ${editor}` });
    return chooser(`System prompt — ${options.type}`, items, "inline", picked => {
      control = undefined;
      if (picked === "external" && editor) act({ kind: "prompt-external", command: editor });
      else act({ kind: "prompt-inline" });
    });
  }

  /** A CSV-list field: a chooser for the presets, a text input for the rest. */
  function listControl(field: AgentFieldSpec, presets: SelectItem[], fromPreset: (picked: string) => void): Control {
    const value = state.values[field.key];
    const open = () => chooser(
      field.label,
      [...presets, { value: CUSTOM, label: "custom list…" }],
      formatValue(field, value),
      picked => {
        if (picked !== CUSTOM) {
          control = undefined;
          fromPreset(picked);
          return;
        }
        control = textInput(field.label, field.hint, csvText(value), text => {
          setValue(field.key, fromListText(field, text));
          return true;
        }, open);
      },
    );
    return open();
  }

  function controlFor(key: string): Control {
    if (key === PROMPT_ROW) return promptControl();
    const field = AGENT_FIELDS.find(candidate => candidate.key === key)!;
    const value = state.values[key];

    switch (field.kind) {
      case "boolean":
        return chooser(
          field.label,
          [{ value: UNSET, label: "default (unset)" }, { value: "on", label: "on" }, { value: "off", label: "off" }],
          formatValue(field, value),
          picked => {
            control = undefined;
            setValue(key, picked === "on" ? true : picked === "off" ? false : undefined);
          },
        );
      case "choice":
        return chooser(
          field.label,
          [{ value: UNSET, label: "default (unset)" }, ...field.options!.map(option => ({ value: option, label: option }))],
          formatValue(field, value),
          picked => {
            control = undefined;
            setValue(key, picked === UNSET ? undefined : picked);
          },
        );
      case "color":
        return chooser(
          field.label,
          [
            { value: UNSET, label: "default (unset)" },
            ...AGENT_COLOR_NAMES.map(name => ({ value: name, label: name })),
            { value: CUSTOM, label: "custom (#RRGGBB)…" },
          ],
          formatValue(field, value),
          picked => {
            if (picked !== CUSTOM) {
              control = undefined;
              setValue(key, picked === UNSET ? undefined : picked);
              return;
            }
            control = textInput(field.label, field.hint, typeof value === "string" ? value : "", text => {
              setValue(key, text.trim() || undefined);
              return true;
            }, () => {
              control = controlFor(key);
            });
          },
        );
      case "tools":
        return listControl(field, [
          { value: "all", label: "all tools (default)" },
          { value: "none", label: "no tools" },
          { value: "read-only", label: `read-only (${READ_ONLY_TOOLS.join(", ")})` },
        ], picked => setValue(key, picked === "all" ? undefined : picked === "none" ? [] : [...READ_ONLY_TOOLS]));
      case "inherit":
        return listControl(field, [
          { value: "all", label: "inherit all (default)" },
          { value: "none", label: "inherit none" },
        ], picked => setValue(key, picked === "all" ? undefined : false));
      case "list":
      case "subagents":
        return textInput(field.label, `${field.hint} Empty clears it.`, csvText(value), text => {
          setValue(key, fromListText(field, text));
          return true;
        }, () => {
          control = undefined;
        });
      case "models":
        return modelPicker(field, value);
      case "integer":
        return textInput(field.label, field.hint, value === undefined ? "" : String(value), text => {
          const trimmed = text.trim();
          if (trimmed === "") {
            setValue(key, undefined);
            return true;
          }
          const parsed = Number(trimmed);
          if (!Number.isInteger(parsed) || parsed < 0) return `Not a whole number of turns: "${trimmed}"`;
          setValue(key, parsed);
          return true;
        }, () => {
          control = undefined;
        });
      case "text":
        return textInput(field.label, field.hint, typeof value === "string" ? value : "", text => {
          setValue(key, text.trim() || undefined);
          return true;
        }, () => {
          control = undefined;
        });
    }
  }

  const header = `Agent · ${options.type}`;

  return {
    render(width: number): string[] {
      const dirty = isDirty();
      const pending = dirty ? touchedCount() : 0;
      const status = pending === 0
        ? dirty ? "unsaved changes" : "no changes"
        : `${pending} unsaved change${pending === 1 ? "" : "s"}`;
      const selectedKey = rows[state.selected];
      const lines: string[] = [header, theme.value(`→ ${options.pathFor(state.scope)}`, false), ""];
      for (let index = 0; index < rows.length; index++) {
        lines.push(fieldRow(rows[index], index === state.selected, width));
      }
      lines.push(
        "",
        theme.description(hintFor(selectedKey)),
        theme.hint(`${status}   Ctrl+S save · Tab switch scope · Enter edit · Esc back`),
      );
      if (control) lines.push("", ...control.render(width));
      return lines;
    },
    invalidate: () => control?.invalidate(),
    handleInput(data: string): void {
      if (control) {
        control.handleInput(data);
        return;
      }
      if (matchesKey(data, "ctrl+s")) {
        act({ kind: "save" });
        return;
      }
      if (matchesKey(data, Key.tab)) {
        state.scope = state.scope === "user" ? "project" : "user";
        return;
      }
      if (matchesKey(data, "up")) {
        state.selected = (state.selected - 1 + rows.length) % rows.length;
        return;
      }
      if (matchesKey(data, "down")) {
        state.selected = (state.selected + 1) % rows.length;
        return;
      }
      if (matchesKey(data, Key.enter)) {
        control = controlFor(rows[state.selected]);
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) act({ kind: "back" });
    },
  };

  function fieldRow(key: string, selected: boolean, width: number): string {
    const field = key === PROMPT_ROW ? undefined : AGENT_FIELDS.find(candidate => candidate.key === key);
    const value = key === PROMPT_ROW ? promptSummary(state.body) : formatValue(field!, state.values[key]);
    const label = `${selected ? theme.cursor : " "} ${field?.label ?? "System prompt"}`;
    const shown = rowChanged(key) ? `${value} *` : value;
    const gap = Math.max(1, width - visibleWidth(label) - visibleWidth(shown));
    return truncateToWidth(`${label}${" ".repeat(gap)}${theme.value(shown, selected)}`, width);
  }

  function hintFor(key: string): string {
    if (key === PROMPT_ROW) return PROMPT_HINT;
    return AGENT_FIELDS.find(field => field.key === key)!.hint;
  }
}

function csvText(value: AgentFieldValue): string {
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : "";
}

/** A CSV line, a list, or `all` for the subagents field. Empty clears the key. */
function fromListText(field: AgentFieldSpec, text: string): AgentFieldValue {
  const items = text.split(",").map(entry => entry.trim()).filter(Boolean);
  if (items.length === 0) return undefined;
  if (field.kind === "subagents" && items.some(item => item === "all" || item === "*")) return "all";
  return items;
}

function promptSummary(body: string): string {
  const lines = body.split("\n").filter(line => line.trim()).length;
  if (lines === 0) return "empty";
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

/**
 * One field's current value, in the words the loader would use.
 *
 * The `Array.isArray` guards are not ceremony: a hand-edited file can put
 * anything under a key, and `readAgentFields` passes a wrong-typed value
 * through rather than inventing a default for it.
 */
function formatValue(field: AgentFieldSpec, value: AgentFieldValue): string {
  const list = Array.isArray(value) ? value : [];
  switch (field.kind) {
    case "boolean":
      return value === undefined ? "default" : value ? "on" : "off";
    case "integer":
      return value === undefined ? "default (unlimited)" : String(value);
    case "tools":
      return value === undefined ? "all (default)" : list.length === 0 ? "none" : list.join(", ");
    case "inherit":
      if (value === undefined) return "all (default)";
      if (value === true) return "all";
      if (value === false) return "none";
      return list.join(", ");
    case "list":
      return list.length === 0 ? "none" : list.join(", ");
    case "subagents":
      return value === undefined ? "none" : value === "all" ? "all" : list.join(", ");
    case "models":
      return list.length === 0
        ? "inherit parent"
        : list.map(id => id.split("/").pop() ?? id).join(" → ");
    default:
      return value === undefined || value === "" ? "default" : String(value);
  }
}
