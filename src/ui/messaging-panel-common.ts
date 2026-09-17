import { basename, dirname } from "node:path";
import { type ExtensionUIContext, keyText } from "@earendil-works/pi-coding-agent";
import {
  Container,
  decodeKittyPrintable,
  getKeybindings,
  Input,
  Spacer,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MessagingStoreMetadata, MessagingTransportMode } from "../messaging/types.js";
import type { Theme } from "./agent-widget.js";
import { clampLine, type WorkflowCardColor, type WorkflowCardLine } from "./workflow-card.js";
import { ASCII_DIALOG_GLYPHS, UNICODE_DIALOG_GLYPHS } from "./workflow-dialog.js";

export const PANEL_REFRESH_MS = 1000;
export const PANEL_BREAKPOINT = 56;

export function printableInput(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data);
  if (decoded !== undefined) return decoded;
  return data.length === 1 && data >= " " && data !== "\u007f" ? data : undefined;
}

export function panelContentWidth(width: number): number {
  return Math.max(1, Math.min(width, width - 6));
}

export function sanitizeTerminalText(value: unknown, multiline = false, ascii = false): string[] {
  const replacement = ascii ? "." : "·";
  const source = stripTerminalSequences(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => {
      let column = 0;
      let result = "";
      for (const character of line) {
        if (character === "\t") {
          const spaces = 2 - (column % 2);
          result += " ".repeat(spaces);
          column += spaces;
        } else if (/^[\u0000-\u001f\u007f-\u009f]$/.test(character)) {
          result += replacement;
          column++;
        } else {
          result += character;
          column += visibleWidth(character);
        }
      }
      return result;
    });
  return multiline ? source : [source.join(" ").replace(/ {2,}/g, " ")];
}

export function singleLine(value: unknown, ascii = false): string {
  return sanitizeTerminalText(value, false, ascii)[0] ?? "";
}

export function wrapPlain(value: unknown, width: number, ascii = false): string[] {
  return sanitizeTerminalText(value, true, ascii).flatMap(line =>
    wrapTextWithAnsi(line || " ", Math.max(1, width)),
  );
}

export function truncateLeft(value: string, width: number, ellipsis = "…"): string {
  if (visibleWidth(value) <= width) return value;
  const room = Math.max(0, width - visibleWidth(ellipsis));
  let shown = "";
  for (const character of [...value].reverse()) {
    if (visibleWidth(character + shown) > room) break;
    shown = character + shown;
  }
  return width <= 0 ? "" : `${ellipsis}${shown}`;
}

export function transportLabel(mode: MessagingTransportMode, compact = false): string {
  if (mode === "socket") return "live";
  if (mode === "starting") return "connecting";
  if (mode === "degraded") return compact ? "polling: unavailable" : "polling (socket unavailable)";
  return "polling";
}

export function headerLines(options: {
  name: "Blackboard" | "Peers";
  info: MessagingStoreMetadata & { transport: MessagingTransportMode };
  count: string;
  width: number;
}): WorkflowCardLine[] {
  const { info, width } = options;
  const scope = `scope ${info.scopeMode}`;
  const store = info.scopeMode === "project" ? truncateLeft(basename(dirname(info.databasePath)), 24) : undefined;
  const transport = transportLabel(info.transport);
  const transportColor: WorkflowCardColor = info.transport === "socket" ? "success" : info.transport === "off" ? "muted" : "warning";
  const append = (line: WorkflowCardLine, text: string, color: WorkflowCardColor = "muted") => {
    if (line.length > 0) line.push({ text: " · ", color: "dim" });
    line.push({ text, color });
  };
  const full: WorkflowCardLine = [{ text: options.name, color: "toolTitle", bold: true }];
  append(full, scope);
  if (store) append(full, store);
  append(full, options.count);
  append(full, transport, transportColor);
  if (lineWidth(full) <= width) return [full];

  const first: WorkflowCardLine = [{ text: options.name, color: "toolTitle", bold: true }];
  append(first, scope);
  const optional = [store, options.count].filter((part): part is string => part !== undefined);
  const compactTransport = transportLabel(info.transport, true);
  while (optional.length > 0 && visibleWidth(`${optional.join(" · ")} · ${compactTransport}`) > width) optional.shift();
  const second: WorkflowCardLine = [];
  for (const part of optional) append(second, part);
  append(second, compactTransport, transportColor);
  return [clampLine(first, width), clampLine(second, width)];
}

function lineWidth(line: WorkflowCardLine): number {
  return line.reduce((total, segment) => total + visibleWidth(segment.text), 0);
}

function pad(line: WorkflowCardLine, width: number): WorkflowCardLine {
  const result: WorkflowCardLine = [];
  let used = 0;
  for (const segment of line) {
    const room = width - used;
    if (room <= 0) break;
    const text = visibleWidth(segment.text) <= room ? segment.text : truncateToWidth(segment.text, room, "…");
    result.push({ ...segment, text });
    used += visibleWidth(text);
  }
  if (used < width) result.push({ text: " ".repeat(width - used) });
  return result;
}

function titleCell(title: string, width: number, focused: boolean, ascii: boolean): WorkflowCardLine {
  const glyphs = ascii ? ASCII_DIALOG_GLYPHS : UNICODE_DIALOG_GLYPHS;
  const prefix = focused ? `${ascii ? ">" : "❯"} ` : "  ";
  const shown = truncateToWidth(singleLine(title, ascii), Math.max(0, width - visibleWidth(prefix) - 2), glyphs.ellipsis);
  const start: WorkflowCardLine = [
    { text: " ", color: "dim" },
    { text: prefix, color: focused ? "accent" : "dim" },
    { text: shown, color: "muted", bold: focused },
    { text: " ", color: "dim" },
  ];
  const gap = Math.max(0, width - lineWidth(start));
  if (gap > 0) start.push({ text: glyphs.box.horizontal.repeat(gap), color: "dim" });
  return pad(start, width);
}

export function paneBlock(options: {
  panes: readonly { title: string; rows: WorkflowCardLine[]; focused: boolean }[];
  width: number;
  bodyRows: number;
  ascii?: boolean;
  framed?: boolean;
}): WorkflowCardLine[] {
  const ascii = options.ascii ?? false;
  const glyphs = ascii ? ASCII_DIALOG_GLYPHS : UNICODE_DIALOG_GLYPHS;
  const framed = (options.framed ?? true) && options.width >= 3;
  if (!framed) {
    const pane = options.panes[0]!;
    return [
      pad([{ text: `${ascii ? ">" : "❯"} `, color: "accent" }, { text: pane.title, color: "muted", bold: true }], options.width),
      ...Array.from({ length: options.bodyRows }, (_, index) => pad(pane.rows[index] ?? [], options.width)),
    ];
  }
  const two = options.panes.length === 2;
  const left = two ? Math.min(28, Math.max(16, Math.floor((options.width - 3) * 0.38))) : options.width - 2;
  const right = two ? Math.max(1, options.width - left - 3) : 0;
  const lines: WorkflowCardLine[] = [];
  lines.push(two
    ? [{ text: glyphs.box.topLeft, color: "dim" }, ...titleCell(options.panes[0]!.title, left, options.panes[0]!.focused, ascii), { text: glyphs.box.topTee, color: "dim" }, ...titleCell(options.panes[1]!.title, right, options.panes[1]!.focused, ascii), { text: glyphs.box.topRight, color: "dim" }]
    : [{ text: glyphs.box.topLeft, color: "dim" }, ...titleCell(options.panes[0]!.title, left, true, ascii), { text: glyphs.box.topRight, color: "dim" }]);
  for (let row = 0; row < options.bodyRows; row++) {
    lines.push(two
      ? [{ text: glyphs.box.vertical, color: "dim" }, ...pad(options.panes[0]!.rows[row] ?? [], left), { text: glyphs.box.vertical, color: "dim" }, ...pad(options.panes[1]!.rows[row] ?? [], right), { text: glyphs.box.vertical, color: "dim" }]
      : [{ text: glyphs.box.vertical, color: "dim" }, ...pad(options.panes[0]!.rows[row] ?? [], left), { text: glyphs.box.vertical, color: "dim" }]);
  }
  lines.push(two
    ? [{ text: glyphs.box.bottomLeft, color: "dim" }, { text: glyphs.box.horizontal.repeat(left), color: "dim" }, { text: glyphs.box.bottomTee, color: "dim" }, { text: glyphs.box.horizontal.repeat(right), color: "dim" }, { text: glyphs.box.bottomRight, color: "dim" }]
    : [{ text: glyphs.box.bottomLeft, color: "dim" }, { text: glyphs.box.horizontal.repeat(left), color: "dim" }, { text: glyphs.box.bottomRight, color: "dim" }]);
  return lines;
}

export function statusLine(text: string, width: number, color: "dim" | "warning" | "error" = "dim"): WorkflowCardLine {
  const parts = text.split(" · ");
  while (parts.length > 1 && visibleWidth(parts.join(" · ")) > width) parts.pop();
  return [{ text: truncateToWidth(parts.join(" · "), width, "…"), color }];
}

/** Keep an identity-resolved selected row inside its independent list window. */
export function listViewportOffset(offset: number, selectedIndex: number, total: number, bodyRows: number): number {
  const max = Math.max(0, total - bodyRows);
  const clamped = Math.max(0, Math.min(offset, max));
  if (selectedIndex < 0) return clamped;
  if (selectedIndex < clamped) return selectedIndex;
  if (selectedIndex >= clamped + bodyRows) return Math.min(max, selectedIndex - bodyRows + 1);
  return clamped;
}

export function viewportRows(hostRows: number, headerRows: number): { bodyRows: number; framed: boolean } {
  const available = Math.max(1, Math.floor(hostRows * 0.7));
  const framedRows = Math.min(22, available - headerRows - 3);
  return framedRows >= 3
    ? { bodyRows: framedRows, framed: true }
    : { bodyRows: Math.max(1, available - headerRows - 2), framed: false };
}

/** Paint the whole overlay row; plain values must not inherit the transcript's SGR. */
export function paintPanelRows(lines: readonly string[], width: number): string[] {
  return lines.map(line => `\x1b[0m${line}\x1b[0m${" ".repeat(Math.max(0, width - visibleWidth(line)))}`);
}

/** Host input geometry and key handling, with a real editable prefill. */
export class MessagingPrefillInput extends Container {
  private readonly input: Input;
  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  constructor(
    private readonly title: string,
    placeholder: string,
    prefill: string,
    private readonly theme: Theme,
    private readonly hostRows: () => number,
    private readonly done: (value: string | undefined) => void,
  ) {
    super();
    this.input = new Input({ placeholder, placeholderStyle: text => theme.fg("dim", text) });
    if (prefill) this.input.handleInput(`\x1b[200~${singleLine(prefill)}\x1b[201~`);
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.confirm") || data === "\n") this.done(this.input.getValue());
    else if (keys.matches(data, "tui.select.cancel")) this.done(undefined);
    else this.input.handleInput(data);
  }

  override render(width: number): string[] {
    this.clear();
    const rule = { render: (w: number) => [this.theme.fg("border", "─".repeat(Math.max(1, w)))], invalidate() {} };
    const hint = `${this.theme.fg("dim", keyText("tui.select.confirm"))}${this.theme.fg("muted", " submit")}  ${this.theme.fg("dim", keyText("tui.select.cancel"))}${this.theme.fg("muted", " cancel")}`;
    const children = [rule, new Text(this.theme.fg("accent", truncateToWidth(singleLine(this.title), Math.max(1, width - 2), "…")), 1, 0), this.input, new Text(truncateToWidth(hint, Math.max(1, width - 2), "…"), 1, 0), rule];
    children.forEach((child, index) => {
      if (index > 0 && this.hostRows() >= 12) this.addChild(new Spacer(1));
      this.addChild(child);
    });
    return paintPanelRows(super.render(width), width);
  }
}

export async function showPrefillInput(ui: Pick<ExtensionUIContext, "custom">, title: string, placeholder: string, prefill: string): Promise<string | undefined> {
  return ui.custom<string | undefined>((tui, theme, _keys, done) => new MessagingPrefillInput(title, placeholder, prefill, theme, () => tui.terminal.rows, done), {
    overlay: true,
    overlayOptions: { anchor: "bottom-center", width: "90%", minWidth: 24, margin: { bottom: 1 } },
  });
}
