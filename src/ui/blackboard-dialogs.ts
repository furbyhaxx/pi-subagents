import { type ExtensionUIContext, keyText } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Editor,
  getKeybindings,
  matchesKey,
  type OverlayHandle,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "./agent-widget.js";
import { paintPanelRows, singleLine, truncateLeft, wrapPlain } from "./messaging-panel-common.js";

export interface BlackboardDialogTarget {
  topic: string;
  key: string;
  revision: number | null;
  author: string;
}

export type BlackboardEditorResult = { kind: "submit"; text: string } | { kind: "cancel" | "quit" };
export type BlackboardReadResult = "continue" | "cancel" | "quit";

/** Read-only acknowledgements and target inspection never receive an editable draft. */
export class BlackboardReadDialog implements Component {
  private scroll = 0;
  private maxScroll = 0;
  private pageRows = 1;
  private width = 36;

  constructor(
    private readonly title: string,
    private readonly text: string,
    private readonly footer: string,
    private readonly mode: "ack" | "target",
    private readonly theme: Theme,
    private readonly hostRows: () => number,
    private readonly done: (result: BlackboardReadResult) => void,
  ) {}

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { this.done("quit"); return; }
    if (keys.matches(data, "tui.select.cancel") || this.mode === "target" && matchesKey(data, "ctrl+o")) { this.done("cancel"); return; }
    if (this.mode === "ack" && (keys.matches(data, "tui.select.confirm") || data === "\n")) { this.done("continue"); return; }
    this.render(this.width);
    if (matchesKey(data, "g") || matchesKey(data, "home")) this.scroll = 0;
    else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) this.scroll = this.maxScroll;
    else {
      const delta = matchesKey(data, "j") || matchesKey(data, "down") ? 1
        : matchesKey(data, "k") || matchesKey(data, "up") ? -1
        : matchesKey(data, "pageDown") || matchesKey(data, "shift+down") ? this.pageRows
        : matchesKey(data, "pageUp") || matchesKey(data, "shift+up") ? -this.pageRows : 0;
      this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + delta));
    }
  }

  render(width: number): string[] {
    this.width = width;
    const inner = Math.max(1, width - 2);
    const body = wrapPlain(this.text, inner);
    const header = [this.theme.fg("muted", this.theme.bold(truncateToWidth(singleLine(this.title), inner, "…")))];
    if (this.mode === "ack") header.push("");
    let footer = wrapPlain(this.footer, inner);
    let viewport = Math.max(1, this.hostRows() - 1 - header.length - footer.length);
    if (body.length > viewport && this.mode === "ack") {
      footer = wrapPlain(`↑↓ scroll · ${this.footer}`, inner);
      viewport = Math.max(1, this.hostRows() - 1 - header.length - footer.length);
    }
    this.pageRows = viewport;
    this.maxScroll = Math.max(0, body.length - viewport);
    this.scroll = Math.min(this.scroll, this.maxScroll);
    const shown = body.slice(this.scroll, this.scroll + viewport);
    while (shown.length < viewport) shown.push("");
    return paintPanelRows([
      ...header,
      ...shown.map(line => this.theme.fg(this.mode === "ack" ? "warning" : "muted", line)),
      ...footer.map(line => this.theme.fg("dim", line)),
    ].map(line => ` ${line}`), width);
  }

  invalidate(): void {}
}

export async function showBlackboardAcknowledgement(
  ui: Pick<ExtensionUIContext, "custom">,
  target: string,
  text: string,
  chooseKey = false,
): Promise<BlackboardReadResult> {
  return ui.custom<BlackboardReadResult>((tui, theme, _keys, done) => new BlackboardReadDialog(
    `${target} · nothing written`, text,
    chooseKey ? "⏎ choose another key · esc discard" : "⏎ back to your text · esc discard",
    "ack", theme, () => tui.terminal.rows, done,
  ), { overlay: true, overlayOptions: { anchor: "bottom-center", width: "90%", minWidth: 24, margin: { bottom: 1 } } });
}

/** Native Editor stays alive across compact/full renders and target inspection. */
export class BlackboardValueEditor extends Container {
  private readonly editor: Editor;
  private inspecting = false;
  private disposed = false;
  private externalUnavailable = false;
  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly title: string,
    private readonly target: BlackboardDialogTarget,
    prefill: string,
    private readonly inspectTarget: () => Promise<BlackboardReadResult>,
    private readonly done: (result: BlackboardEditorResult) => void,
  ) {
    super();
    this.editor = new Editor(tui, {
      borderColor: text => theme.fg("borderMuted", text),
      selectList: {
        selectedPrefix: text => theme.fg("accent", text),
        selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text),
        scrollInfo: text => theme.fg("muted", text),
        noMatch: text => theme.fg("muted", text),
      },
    }, { paddingX: 1 });
    this.editor.setText(prefill);
    // Native submit clears the editor and trims its callback value. Keep the
    // pre-clear expanded draft so Blackboard raw strings retain whitespace.
    let draft = this.editor.getExpandedText();
    let beforeChange = draft;
    this.editor.onChange = () => {
      beforeChange = draft;
      draft = this.editor.getExpandedText();
    };
    this.editor.onSubmit = () => this.done({ kind: "submit", text: beforeChange });
  }

  handleInput(data: string): void {
    if (this.disposed || this.inspecting) return;
    this.externalUnavailable = false;
    if (getKeybindings().matches(data, "tui.select.cancel")) this.done({ kind: "cancel" });
    else if (matchesKey(data, "ctrl+o")) void this.openTarget();
    else if (matchesKey(data, "ctrl+g")) this.externalUnavailable = true;
    else this.editor.handleInput(data);
  }

  private async openTarget(): Promise<void> {
    this.inspecting = true;
    try {
      const result = await this.inspectTarget();
      if (!this.disposed && result === "quit") this.done({ kind: "quit" });
    } finally {
      this.inspecting = false;
      if (!this.disposed) this.tui.requestRender();
    }
  }

  override render(width: number): string[] {
    this.clear();
    const rows = this.tui.terminal.rows;
    const full = rows >= 17;
    const room = Math.max(1, width - 2);
    const key = singleLine(this.target.key);
    const topic = singleLine(this.target.topic);
    const prefix = this.target.revision === null ? "New " : "";
    const revision = this.target.revision === null ? "" : ` · rev ${this.target.revision}`;
    let suffix = full ? "" : " · JSON or text";
    if (visibleWidth(prefix + key + revision + suffix) > room) suffix = "";
    const targetRoom = Math.max(1, room - visibleWidth(prefix + revision + suffix));
    const address = visibleWidth(key) < targetRoom
      ? truncateLeft(`${topic}/${key}`, targetRoom)
      : truncateToWidth(key, targetRoom, "…");
    const context = `${prefix}${address}${revision}${suffix}`;
    const rule: Component = { render: w => [this.theme.fg("border", "─".repeat(w))], invalidate() {} };
    const contextLine = new Text(this.theme.fg("accent", context), 1, 0);
    if (rows >= 11) this.addChild(rule);
    if (full) this.addChild(new Spacer(1));
    this.addChild(contextLine);
    if (full) {
      this.addChild(new Text(this.theme.fg("accent", truncateToWidth(singleLine(this.title), room, "…")), 1, 0));
      this.addChild(new Spacer(1));
    }
    this.addChild({
      render: w => {
        const lines = this.editor.render(w);
        const missing = Math.max(0, 2 + Math.max(5, Math.floor(rows * 0.3)) - lines.length);
        lines.splice(lines.length - 1, 0, ...Array.from({ length: missing }, () => " ".repeat(w)));
        return lines;
      },
      invalidate: () => this.editor.invalidate(),
    });
    if (full) this.addChild(new Spacer(1));
    const hints = [
      `${keyText("tui.input.submit")} submit`,
      `${keyText("tui.select.cancel")} cancel`,
      `${keyText("tui.input.newLine")} newline`,
      "ctrl+o target",
    ];
    while (hints.length > 1 && visibleWidth(hints.join("  ")) > room) hints.pop();
    this.addChild(new Text(this.theme.fg("dim", this.externalUnavailable ? "External editor unavailable here." : hints.join("  ")), 1, 0));
    if (full) this.addChild(new Spacer(1));
    if (rows >= 11) this.addChild(rule);
    return paintPanelRows(super.render(width), width);
  }

  dispose(): void { this.disposed = true; }
}

export async function showBlackboardValueEditor(
  ui: Pick<ExtensionUIContext, "custom">,
  title: string,
  target: BlackboardDialogTarget,
  prefill: string,
): Promise<BlackboardEditorResult> {
  let overlay: OverlayHandle | undefined;
  let host: TUI | undefined;
  return ui.custom<BlackboardEditorResult>((tui, theme, _keys, done) => {
    host = tui;
    return new BlackboardValueEditor(tui, theme, title, target, prefill, async () => {
      try {
        return await ui.custom<BlackboardReadResult>((targetTui, targetTheme, _targetKeys, targetDone) => new BlackboardReadDialog(
          "Target", `topic ${target.topic}\nkey ${target.key}\nrev ${target.revision ?? "new entry"}\nauthor ${target.author}`,
          "esc back to your text", "target", targetTheme, () => targetTui.terminal.rows, targetDone,
        ), { overlay: true, overlayOptions: { anchor: "bottom-center", width: "90%", minWidth: 24, margin: { bottom: 1 } } });
      } finally { overlay?.focus(); }
    }, done);
  }, {
    overlay: true,
    // The installed host resolves an options factory only once. The public
    // margin getter is read by the TUI on each layout, including resize.
    overlayOptions: { anchor: "bottom-center", width: "90%", minWidth: 24, margin: { get bottom() { return (host?.terminal.rows ?? 24) >= 17 ? 1 : 0; } } },
    onHandle: handle => { overlay = handle; },
  });
}
