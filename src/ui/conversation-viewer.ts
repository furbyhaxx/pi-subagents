import {
  type AgentSession,
  type AgentSessionEvent,
  getMarkdownTheme,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Input,
  Markdown,
  type MarkdownOptions,
  type MarkdownTheme,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord, ViewerMarkdownMode, ViewerViewMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import {
  type AgentActivity,
  buildInvocationTags,
  describeActivity,
  fgPreservingNestedStyles,
  formatCost,
  formatDuration,
  formatSessionTokens,
  getPromptModeLabel,
  type Theme,
} from "./agent-widget.js";
import {
  isFileWriteTool,
  isKeyStep,
  isToolStep,
  TranscriptModel,
  type TranscriptRawBlock,
  type TranscriptSnapshot,
  type TranscriptStep,
} from "./transcript-model.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

export const VIEWPORT_HEIGHT_PCT = 70;
export const RESULT_MAX_CHARS = 16_000;

const MARKDOWN_MODES: readonly ViewerMarkdownMode[] = ["off", "assistant", "all"];
const BODY_HEAD_LINES = 30;
const BODY_TAIL_LINES = 10;
const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

type FilterMode = "all" | "key" | "tools";
type ReadingRegion = "timeline" | "preview" | "task" | "raw";
type PagerLayer = "help" | "detail";

type FlatStep = {
  key: string;
  step: TranscriptStep;
  depth: number;
  parentKey?: string;
  owner?: ChildConversation;
};

type PhysicalRow =
  | { kind: "header"; node: FlatStep }
  | { kind: "body"; node: FlatStep; text: string; bodyRow: number; sourceLine?: number; omission?: boolean };

type SavedView = {
  region: ReadingRegion;
  selectedKey?: string;
  scroll: number;
  previewOffset: number;
  following: boolean;
  sourceId?: string;
};

export interface ChildConversation {
  record: AgentRecord & { taskPrompt?: string };
  session: AgentSession;
  activity?: AgentActivity;
  onStop?: () => void;
  onSteer?: (message: string) => void;
}

export interface ConversationViewerOptions {
  resolveChildren?: (parent: AgentRecord, step: TranscriptStep) => readonly ChildConversation[];
  parent?: AgentRecord;
  ancestorIds?: readonly string[];
  initialStepKey?: string;
}

function fallbackMarkdownTheme(theme: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: (text) => theme.bold(theme.fg("accent", text)),
    link: (text) => theme.fg("accent", text),
    linkUrl: (text) => theme.fg("muted", text),
    code: (text) => theme.fg("muted", text),
    codeBlock: (text) => theme.fg("muted", text),
    codeBlockBorder: (text) => theme.fg("dim", text),
    quote: (text) => theme.fg("muted", text),
    quoteBorder: (text) => theme.fg("dim", text),
    hr: (text) => theme.fg("dim", text),
    listBullet: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

function resolveMarkdownTheme(theme: Theme): MarkdownTheme {
  try {
    const markdownTheme = getMarkdownTheme();
    markdownTheme.heading("probe");
    return markdownTheme;
  } catch {
    return fallbackMarkdownTheme(theme);
  }
}

function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return { text: text.slice(0, RESULT_MAX_CHARS), elided: text.length - RESULT_MAX_CHARS };
}

function humanCount(value: number): string {
  if (value < 1_000) return String(value);
  const thousands = value < 999_950;
  const scaled = thousands ? value / 1_000 : value / 1_000_000;
  return `${scaled.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number): string {
  return `... (truncated, ${humanCount(elided)} more character${elided === 1 ? "" : "s"})`;
}

function clock(timestamp: number | undefined): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function elapsedLabel(milliseconds: number | undefined): string {
  if (milliseconds === undefined || milliseconds <= 0) return "";
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes}m${String(Math.round((milliseconds % 60_000) / 1000)).padStart(2, "0")}s`;
}

function stepStatus(step: TranscriptStep): string {
  if (step.running) return "running";
  if (step.isError) return "error";
  if (step.kind === "agent" && step.outcome) return step.outcome;
  return "ok";
}

function stepGlyph(step: TranscriptStep): { glyph: string; color: string } {
  if (step.running) return { glyph: "⧗", color: "accent" };
  if (step.isError) return { glyph: "✗", color: "error" };
  if (step.kind === "text") return { glyph: "◆", color: "text" };
  if (step.kind === "rollup") return { glyph: "▪", color: "dim" };
  if (step.kind === "agent") return { glyph: "⚙", color: "accent" };
  if (step.kind === "compaction") return { glyph: "⌥", color: "muted" };
  if (step.kind === "steer") return { glyph: "✎", color: "accent" };
  if (step.kind === "error") return { glyph: "✗", color: "error" };
  if (isFileWriteTool(step.label)) return { glyph: "✎", color: "accent" };
  return { glyph: "✓", color: "success" };
}

function historyOf(session: AgentSession): readonly SessionEntry[] {
  const manager = session.sessionManager as AgentSession["sessionManager"] | undefined;
  return manager?.getBranch ? manager.getBranch() : [];
}

function wholeTokens(tokens: readonly string[], width: number): string {
  let output = "";
  for (const token of tokens) {
    const candidate = output ? `${output} · ${token}` : token;
    if (visibleWidth(candidate) > width) break;
    output = candidate;
  }
  return output;
}

export class ConversationViewer implements Component {
  private readonly keys: ViewerKeys;
  private readonly markdownTheme: MarkdownTheme;
  private readonly model: TranscriptModel;
  private snapshot: TranscriptSnapshot;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private markdownModeOverride: ViewerMarkdownMode | undefined;
  private viewModeOverride: ViewerViewMode | undefined;
  private filterMode: FilterMode = "all";
  private readingRegion: ReadingRegion = "timeline";
  private priorRegion: ReadingRegion = "timeline";
  private layer: PagerLayer | undefined;
  private layerScroll = 0;
  private layerOrigin: SavedView | undefined;
  private detailNode: FlatStep | undefined;
  private detailKey: string | undefined;
  private detailLinesCache: { signature: string; lines: string[]; sourceRows: number[] } | undefined;
  private helpLinesCache: { width: number; lines: string[] } | undefined;
  private selectedKey: string | undefined;
  private timelineScroll = 0;
  private rawScroll = 0;
  private previewOffset = 0;
  private taskExpanded = false;
  private taskScroll = 0;
  private taskAtEnd = false;
  private taskCache: { signature: string; lines: string[] } | undefined;
  private following = true;
  private pausedCount = 0;
  private previousStepCount = 0;
  private stopArmed = false;
  private stopPending = false;
  private composer: Input | undefined;
  private composerRegion: ReadingRegion | undefined;
  private message = "";
  private readonly expanded = new Set<string>();
  private readonly previewOpen = new Set<string>();
  private readonly previewOffsets = new Map<string, number>();
  private readonly previewCache = new Map<string, { signature: string; rows: PhysicalRow[] }>();
  private readonly rawCache = new Map<string, { signature: string; lines: string[] }>();
  private readonly markdownCache = new WeakMap<object, { markdown: Markdown; text: string; failed: boolean }>();
  private readonly savedViews = new Map<ViewerViewMode, SavedView>();
  private readonly inlineChildren = new Map<string, { model: TranscriptModel; snapshot: TranscriptSnapshot; unsubscribe: () => void }>();
  private readonly resolvedChildren = new Map<string, readonly ChildConversation[]>();
  private lastWidth = 0;
  private lastViewport = 1;
  private childViewer: ConversationViewer | undefined;
  private childOrigin: SavedView | undefined;

  /** Read-only probes used by focused navigation tests. */
  get scrollOffset(): number {
    return this.viewMode() === "raw" ? this.rawScroll : this.timelineScroll;
  }

  get cursor(): number {
    return Math.max(0, this.flatSteps().findIndex((node) => node.key === this.selectedKey));
  }

  constructor(
    private readonly tui: TUI,
    private readonly session: AgentSession,
    private readonly record: AgentRecord,
    private readonly activity: AgentActivity | undefined,
    private readonly theme: Theme,
    private readonly done: (result: undefined) => void,
    private readonly onStop?: () => void,
    keybindings?: ViewerKeybindings,
    private readonly onSteer?: (message: string) => void,
    private readonly showCost = false,
    private readonly viewerMarkdown?: () => ViewerMarkdownMode,
    private readonly onMarkdownMode?: (mode: ViewerMarkdownMode) => void,
    private readonly viewerMode?: () => ViewerViewMode,
    private readonly onViewMode?: (mode: ViewerViewMode) => void,
    private readonly options: ConversationViewerOptions = {},
  ) {
    this.keys = createViewerKeys(keybindings);
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.model = new TranscriptModel(historyOf(session), record as AgentRecord & { taskPrompt?: string });
    this.snapshot = this.model.sync(session.messages);
    this.previousStepCount = this.snapshot.steps.length;
    this.selectedKey = options.initialStepKey;
    if (options.initialStepKey) this.revealStep(options.initialStepKey);
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
  }

  handleInput(data: string): void {
    if (this.childViewer) {
      this.childViewer.handleInput(data);
      return;
    }
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.layer) {
      this.handlePagerInput(data);
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.close();
      return;
    }

    if (matchesKey(data, "x")) {
      if (this.stopPending) {
        this.message = "Stop requested.";
      } else if (!this.isStoppable()) {
        this.message = "Stop unavailable for this conversation.";
      } else if (this.stopArmed) {
        this.stopArmed = false;
        this.stopPending = true;
        try {
          this.onStop?.();
          this.message = "Stop requested.";
        } catch {
          this.stopPending = false;
          this.message = "Stop failed. Press x twice to retry.";
        }
      } else {
        this.stopArmed = true;
      }
      this.tui.requestRender();
      return;
    }

    if (this.stopArmed) this.stopArmed = false;
    if (!this.stopPending) this.message = "";

    if (matchesKey(data, "?")) {
      this.openLayer("help");
      return;
    }
    if (matchesKey(data, "enter")) {
      if (this.canSteer()) this.openComposer();
      else {
        this.message = "Steering unavailable for this conversation.";
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "m")) {
      const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
      this.markdownModeOverride = next;
      this.onMarkdownMode?.(next);
      this.clearTextCaches();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.switchView();
      return;
    }
    if (matchesKey(data, "t")) {
      this.toggleTask();
      return;
    }
    if (data === "O") {
      this.openChild();
      return;
    }
    if (matchesKey(data, "o")) {
      this.openDetail();
      return;
    }
    if (matchesKey(data, "y")) {
      this.message = "Clipboard unavailable in this host.";
      this.tui.requestRender();
      return;
    }

    if (this.readingRegion === "task") this.handleTaskInput(data);
    else if (this.viewMode() === "raw") this.handleRawInput(data);
    else this.handleStepsInput(data);
  }

  render(width: number): string[] {
    if (width < 6) return [];
    if (this.childViewer) return this.childViewer.render(width);

    this.lastWidth = width;
    if (this.layer) return this.renderPager(width);

    const innerWidth = width - 4;
    const allocated = Math.max(5, Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100));
    const invocation = allocated >= 11 ? this.invocationLine() : undefined;
    if (this.stopPending && !this.isStoppable()) {
      this.stopPending = false;
      if (this.message === "Stop requested.") this.message = "";
    }
    const composerRows = this.composer ? 1 : 0;
    const maxTaskRows = Math.max(1, Math.floor(allocated * 0.4));
    const taskBudget = Math.min(maxTaskRows, Math.max(1, allocated - 5 - composerRows));
    const taskRows = this.renderTask(innerWidth, taskBudget);
    const chrome = 2 + 1 + (invocation ? 1 : 0) + taskRows.length + 1 + composerRows;
    const viewport = Math.max(1, allocated - chrome);
    this.lastViewport = viewport;

    const lines: string[] = [this.border(width, "top")];
    lines.push(this.row(this.headerLine(), innerWidth));
    if (invocation) lines.push(this.row(invocation, innerWidth));
    for (const taskRow of taskRows) lines.push(this.row(taskRow, innerWidth));

    const content = this.viewMode() === "raw"
      ? this.renderRawViewport(innerWidth, viewport)
      : this.renderStepsViewport(innerWidth, viewport);
    if (this.message && content.length > 0) content[0] = this.theme.fg("warning", this.message);
    for (let index = 0; index < viewport; index++) lines.push(this.row(content[index] ?? "", innerWidth));

    if (this.composer) lines.push(this.row(this.composer.render(innerWidth)[0] ?? "", innerWidth));
    lines.push(this.row(this.footer(innerWidth), innerWidth));
    lines.push(this.border(width, "bottom"));
    return lines;
  }

  invalidate(): void {
    this.clearTextCaches();
    this.childViewer?.invalidate();
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.childViewer?.dispose();
    this.childViewer = undefined;
    for (const child of this.inlineChildren.values()) child.unsubscribe();
    this.inlineChildren.clear();
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    if (this.closed) return;
    const before = this.snapshot;
    this.snapshot = this.model.handleEvent(event);
    if (event.type === "entry_appended" || event.type === "message_end") {
      this.stopPending = false;
      if (!this.following && this.snapshot.steps.length > this.previousStepCount) {
        this.pausedCount += this.snapshot.steps.length - this.previousStepCount;
      }
      this.previousStepCount = this.snapshot.steps.length;
    }
    if (this.snapshot.contentRevision !== before.contentRevision) {
      const previousRevisions = new Map(before.raw.map((block) => [block.sourceId, block.sourceRevision]));
      for (const block of this.snapshot.raw) {
        if (previousRevisions.get(block.sourceId) !== block.sourceRevision) this.rawCache.delete(block.key);
      }
      for (const [key] of this.previewCache) {
        const node = this.flatSteps().find((candidate) => candidate.key === key);
        if (!node || previousRevisions.get(node.step.sourceId) !== node.step.sourceRevision) this.previewCache.delete(key);
      }
      if (this.detailNode && previousRevisions.get(this.detailNode.step.sourceId) !== this.detailNode.step.sourceRevision) {
        this.detailLinesCache = undefined;
      }
      if (before.task !== this.snapshot.task) this.taskCache = undefined;
      this.resolvedChildren.clear();
    }
    this.tui.requestRender();
  }

  private close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const child of this.inlineChildren.values()) child.unsubscribe();
    this.inlineChildren.clear();
    this.done(undefined);
  }

  private markdownMode(): ViewerMarkdownMode {
    return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
  }

  private viewMode(): ViewerViewMode {
    return this.viewModeOverride ?? this.viewerMode?.() ?? "steps";
  }

  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  private openComposer(): void {
    this.composerRegion = this.readingRegion;
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value) => {
      const text = value.trim();
      this.composer = undefined;
      this.readingRegion = this.composerRegion ?? "timeline";
      if (text) this.onSteer?.(text);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.readingRegion = this.composerRegion ?? "timeline";
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  private switchView(): void {
    const current = this.viewMode();
    const next: ViewerViewMode = current === "steps" ? "raw" : "steps";
    this.savedViews.set(current, this.captureView());
    const saved = this.savedViews.get(next);
    this.viewModeOverride = next;
    this.onViewMode?.(next);
    if (saved) this.restoreView(saved);
    else {
      const node = this.focusedNode();
      const sourceId = node?.step.sourceId;
      if (next === "raw") {
        const rows = this.rawPhysical(Math.max(1, this.lastWidth - 4));
        const index = sourceId ? rows.findIndex((row) => row.block.sourceId === sourceId) : -1;
        this.rawScroll = Math.max(0, index);
        this.readingRegion = "raw";
      } else {
        const nodeForSource = this.flatSteps().find((entry) => entry.step.sourceId === sourceId);
        if (nodeForSource) this.selectedKey = nodeForSource.key;
        this.readingRegion = "timeline";
      }
    }
    this.tui.requestRender();
  }

  private captureView(): SavedView {
    const rawSource = this.viewMode() === "raw"
      ? this.rawPhysical(Math.max(1, this.lastWidth - 4))[this.rawScroll]?.block.sourceId
      : undefined;
    return {
      region: this.readingRegion,
      selectedKey: this.selectedKey,
      scroll: this.viewMode() === "raw" ? this.rawScroll : this.timelineScroll,
      previewOffset: this.previewOffset,
      following: this.following,
      sourceId: rawSource ?? this.focusedNode()?.step.sourceId,
    };
  }

  private restoreView(saved: SavedView): void {
    this.readingRegion = saved.region;
    this.selectedKey = saved.selectedKey;
    if (this.viewMode() === "raw") this.rawScroll = saved.scroll;
    else this.timelineScroll = saved.scroll;
    this.previewOffset = saved.previewOffset;
    this.following = saved.following;
  }

  private revealStep(key: string): void {
    const index = this.flatSteps().findIndex((node) => node.key === key || node.step.key === key);
    if (index < 0) return;
    const node = this.flatSteps()[index];
    if (!node) return;
    this.selectedKey = node.key;
    this.timelineScroll = Math.max(0, index);
    this.readingRegion = "timeline";
    this.following = false;
  }

  private toggleTask(): void {
    if (!this.snapshot.task) {
      this.message = "No task text available.";
      this.tui.requestRender();
      return;
    }
    if (!this.taskExpanded) {
      this.taskExpanded = true;
      this.priorRegion = this.readingRegion;
      this.readingRegion = "task";
      this.following = false;
    } else if (this.readingRegion !== "task") {
      this.priorRegion = this.readingRegion;
      this.readingRegion = "task";
    } else {
      this.taskExpanded = false;
      this.readingRegion = this.priorRegion;
    }
    this.tui.requestRender();
  }

  private taskDocument(width: number): string[] {
    const task = this.snapshot.task ?? "";
    const spawn: string[] = [];
    if (this.record.worktree) {
      spawn.push(`worktree ${this.record.worktree.branch}`, `path ${this.record.worktree.path}`, `lifecycle ${this.record.worktree.lifecycle}`);
    } else if (this.record.branch) {
      spawn.push(`branch ${this.record.branch}`);
    }
    if (this.record.effectiveCwd) spawn.push(`cwd ${this.record.effectiveCwd}`);
    const source = spawn.length > 0 ? `${task}\n\nspawn\n${spawn.join(" · ")}` : task;
    const signature = `${width}|${this.markdownMode()}|${source}`;
    if (this.taskCache?.signature === signature) return this.taskCache.lines;
    const lines = this.renderText(source, width, this.markdownMode() !== "off", false);
    this.taskCache = { signature, lines };
    return lines;
  }

  private renderTask(width: number, budget: number): string[] {
    const task = this.snapshot.task;
    if (!task || budget <= 0) return [];
    const document = this.taskDocument(width);
    if (!this.taskExpanded) {
      const bodyRows = Math.max(0, Math.min(2, budget - 1));
      const shown = document.slice(0, bodyRows);
      const hidden = Math.max(0, document.length - shown.length);
      return [
        this.theme.fg("dim", `Task · t expand${hidden ? ` (+${hidden} lines)` : ""}`),
        ...shown,
      ].slice(0, budget);
    }
    const bodyRows = Math.max(0, budget - 1);
    const maxScroll = Math.max(0, document.length - bodyRows);
    this.taskScroll = this.taskAtEnd ? maxScroll : Math.min(this.taskScroll, maxScroll);
    const start = document.length === 0 ? 0 : this.taskScroll + 1;
    const end = Math.min(document.length, this.taskScroll + bodyRows);
    return [
      this.theme.fg("dim", `Task ${start}-${end}/${document.length} · t collapse`),
      ...document.slice(this.taskScroll, this.taskScroll + bodyRows),
    ];
  }

  private handleTaskInput(data: string): void {
    const total = this.taskDocument(Math.max(1, this.lastWidth - 4)).length;
    const page = Math.max(1, Math.floor(Math.max(1, this.lastViewport) * 0.4));
    const max = Math.max(0, total - page);
    if (this.keys.scrollUp(data)) this.taskScroll = Math.max(0, this.taskScroll - 1);
    else if (this.keys.scrollDown(data)) this.taskScroll = Math.min(max, this.taskScroll + 1);
    else if (this.keys.pageUp(data)) this.taskScroll = Math.max(0, this.taskScroll - page);
    else if (this.keys.pageDown(data)) this.taskScroll = Math.min(max, this.taskScroll + page);
    else if (matchesKey(data, "home")) this.taskScroll = 0;
    else if (matchesKey(data, "end")) {
      this.taskScroll = max;
      this.taskAtEnd = true;
      this.tui.requestRender();
      return;
    } else return;
    this.taskAtEnd = false;
    this.tui.requestRender();
  }

  private filteredSteps(): readonly TranscriptStep[] {
    if (this.filterMode === "key") return this.snapshot.steps.filter(isKeyStep);
    if (this.filterMode === "tools") return this.snapshot.steps.filter(isToolStep);
    return this.snapshot.steps;
  }

  private flatSteps(): FlatStep[] {
    const rows: FlatStep[] = [];
    const snapshotFor = (child: ChildConversation): TranscriptSnapshot => {
      let cached = this.inlineChildren.get(child.record.id);
      if (!cached) {
        const model = new TranscriptModel(historyOf(child.session), child.record as AgentRecord & { taskPrompt?: string });
        const entry = {
          model,
          snapshot: model.sync(child.session.messages),
          unsubscribe: () => {},
        };
        entry.unsubscribe = child.session.subscribe((event) => {
          entry.snapshot = model.handleEvent(event);
          if (!this.closed) this.tui.requestRender();
        });
        cached = entry;
        this.inlineChildren.set(child.record.id, entry);
      }
      return cached.snapshot;
    };
    const visit = (step: TranscriptStep, depth: number, parentKey?: string, owner?: ChildConversation) => {
      const nodeKey = owner ? `${owner.record.id}/${step.key}` : step.key;
      rows.push({ key: nodeKey, step, depth, parentKey, owner });
      if (!this.expanded.has(nodeKey)) return;
      if (step.kind === "rollup") {
        for (const child of step.children ?? []) visit(child, depth + 1, step.key, owner);
      } else if (step.kind === "agent" && owner && step.key.startsWith("child:")) {
        for (const childStep of snapshotFor(owner).steps) visit(childStep, depth + 1, step.key, owner);
      } else if (step.kind === "agent" && depth === 0) {
        const resolutionKey = `${this.record.id}:${step.key}`;
        let children = this.resolvedChildren.get(resolutionKey);
        if (!children) {
          children = this.options.resolveChildren?.(this.record, step) ?? [];
          if (children.length > 0) this.resolvedChildren.set(resolutionKey, children);
        }
        if (children.length === 1) {
          const child = children[0]!;
          for (const childStep of snapshotFor(child).steps) visit(childStep, depth + 1, step.key, child);
        } else {
          for (const child of children) {
            visit({
              key: `child:${child.record.id}`,
              sourceId: step.sourceId,
              sourceRevision: step.sourceRevision,
              kind: "agent",
              at: child.record.startedAt,
              label: child.record.type,
              target: child.record.description,
              outcome: child.record.status,
              childAgentIds: [child.record.id],
            }, depth + 1, step.key, child);
          }
        }
      }
    };
    for (const step of this.filteredSteps()) visit(step, 0);
    return rows;
  }

  private previewRows(node: FlatStep, width: number): PhysicalRow[] {
    const sections = node.step.bodySections ?? [];
    const signature = `${width}|${this.markdownMode()}|${node.step.sourceRevision}|${sections.map((section) => `${section.label}:${section.text}`).join("|")}`;
    const cached = this.previewCache.get(node.key);
    if (cached?.signature === signature) return cached.rows;
    const source: { text: string; sourceLine?: number; omission?: boolean; markdown?: boolean }[] = [];
    let absoluteLine = 0;
    for (const section of sections) {
      if (sections.length > 1) source.push({ text: section.label });
      const markdown = this.sectionMarkdown(section);
      const lines = section.text.split("\n");
      const selected = lines.length > BODY_HEAD_LINES + BODY_TAIL_LINES
        ? [
            ...lines.slice(0, BODY_HEAD_LINES).map((text, index) => ({ text, sourceLine: absoluteLine + index, markdown })),
            { text: `${lines.length - BODY_HEAD_LINES - BODY_TAIL_LINES} lines hidden · o full`, omission: true, sourceLine: absoluteLine + BODY_HEAD_LINES },
            ...lines.slice(-BODY_TAIL_LINES).map((text, index) => ({ text, sourceLine: absoluteLine + lines.length - BODY_TAIL_LINES + index, markdown })),
          ]
        : lines.map((text, index) => ({ text, sourceLine: absoluteLine + index, markdown }));
      source.push(...selected);
      absoluteLine += lines.length;
    }
    const rows: PhysicalRow[] = [];
    for (const item of source) {
      const wrapped = item.markdown
        ? this.markdownStandalone(item.text, Math.max(1, width - 5), false)
        : wrapTextWithAnsi(item.text, Math.max(1, width - 5));
      for (const text of wrapped.length > 0 ? wrapped : [""]) {
        rows.push({ kind: "body", node, text, bodyRow: rows.length, sourceLine: item.sourceLine, omission: item.omission });
      }
    }
    this.previewCache.set(node.key, { signature, rows });
    return rows;
  }

  private physicalRows(width: number): PhysicalRow[] {
    const rows: PhysicalRow[] = [];
    for (const node of this.flatSteps()) {
      rows.push({ kind: "header", node });
      if (this.previewOpen.has(node.key)) rows.push(...this.previewRows(node, width));
    }
    return rows;
  }

  private renderStepsViewport(width: number, viewport: number): string[] {
    const nodes = this.flatSteps();
    if (nodes.length === 0) {
      return [this.theme.fg("dim", this.filterMode === "all" ? "Waiting for the first step…" : "No matching steps. f changes filter.")];
    }
    if (!this.selectedKey || !nodes.some((node) => node.key === this.selectedKey)) this.selectedKey = nodes.at(-1)?.key;
    const physical = this.physicalRows(width);
    let selectedRow = physical.findIndex((row) => row.node.key === this.selectedKey && row.kind === (this.readingRegion === "preview" ? "body" : "header"));
    if (this.readingRegion === "preview") {
      const bodyRows = physical.filter((row) => row.kind === "body" && row.node.key === this.selectedKey);
      const selectedBody = bodyRows[Math.min(this.previewOffset, Math.max(0, bodyRows.length - 1))];
      selectedRow = selectedBody ? physical.indexOf(selectedBody) : selectedRow;
    }
    selectedRow = Math.max(0, selectedRow);
    const max = Math.max(0, physical.length - viewport);
    if (this.following) {
      this.selectedKey = nodes.at(-1)?.key;
      this.readingRegion = "timeline";
      this.timelineScroll = max;
    } else if (selectedRow < this.timelineScroll) this.timelineScroll = selectedRow;
    else if (selectedRow >= this.timelineScroll + viewport) this.timelineScroll = selectedRow - viewport + 1;
    this.timelineScroll = Math.min(max, Math.max(0, this.timelineScroll));

    return physical.slice(this.timelineScroll, this.timelineScroll + viewport).map((row) => {
      if (row.kind === "header") return this.stepRow(row.node, width, row.node.key === this.selectedKey && this.readingRegion !== "preview");
      const focused = row.node.key === this.selectedKey && this.readingRegion === "preview" && row.bodyRow === this.previewOffset;
      const prefix = focused ? this.theme.fg("accent", "❯  │ ") : "   │ ";
      return truncateToWidth(prefix + row.text, width);
    });
  }

  private stepRow(node: FlatStep, width: number, focused: boolean): string {
    const step = node.step;
    const open = this.expanded.has(node.key) || this.previewOpen.has(node.key);
    const expandable = !!step.bodySections?.length || !!step.children?.length || step.kind === "agent";
    const disclosure = expandable ? (open ? "▾" : "▸") : " ";
    const { glyph, color } = stepGlyph(step);
    const time = width >= 56 ? `${clock(step.at)} ` : "";
    const duration = width >= 72 ? elapsedLabel(step.running && step.at ? Date.now() - step.at : step.durationMs) : "";
    const label = step.kind === "rollup" ? `${step.children?.length ?? 0} steps` : step.label;
    const target = step.kind === "rollup" ? step.summary ?? "" : step.target ?? "";
    const status = stepStatus(step);
    const indent = "  ".repeat(node.depth);
    const prefix = `${focused ? "❯" : " "}${indent}${disclosure} ${time}${glyph} ${label} `;
    const suffix = `${step.outcome && step.outcome !== target ? `→ ${step.outcome} · ` : ""}${status}${duration ? ` · ${duration}` : ""}`;
    const available = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix) - 1);
    const middle = truncateToWidth(target, available, "…");
    const gap = " ".repeat(Math.max(1, width - visibleWidth(prefix) - visibleWidth(middle) - visibleWidth(suffix)));
    return truncateToWidth(
      (focused ? this.theme.fg("accent", "❯") : " ")
        + this.theme.fg("dim", `${indent}${disclosure} ${time}`)
        + this.theme.fg(color, glyph)
        + ` ${step.isError ? this.theme.fg("error", label) : label} ${focused ? this.theme.bold(middle) : middle}${gap}`
        + this.theme.fg(step.isError ? "error" : "dim", suffix),
      width,
    );
  }

  private focusedNode(): FlatStep | undefined {
    const nodes = this.flatSteps();
    return nodes.find((node) => node.key === this.selectedKey) ?? nodes.at(-1);
  }

  private handleStepsInput(data: string): void {
    const nodes = this.flatSteps();
    if (nodes.length === 0) {
      if (matchesKey(data, "f")) this.cycleFilter();
      return;
    }
    let index = Math.max(0, nodes.findIndex((node) => node.key === this.selectedKey));
    const node = nodes[index];
    if (!node) return;

    if (this.readingRegion === "preview") {
      const rows = this.previewRows(node, Math.max(1, this.lastWidth - 4));
      const max = Math.max(0, rows.length - 1);
      if (this.keys.scrollUp(data)) this.previewOffset = Math.max(0, this.previewOffset - 1);
      else if (this.keys.scrollDown(data)) this.previewOffset = Math.min(max, this.previewOffset + 1);
      else if (this.keys.pageUp(data)) this.previewOffset = Math.max(0, this.previewOffset - this.lastViewport);
      else if (this.keys.pageDown(data)) this.previewOffset = Math.min(max, this.previewOffset + this.lastViewport);
      else if (matchesKey(data, "home")) this.previewOffset = 0;
      else if (matchesKey(data, "end")) this.previewOffset = max;
      else if (matchesKey(data, "left")) this.readingRegion = "timeline";
      else if (matchesKey(data, "space")) {
        this.previewOpen.delete(node.key);
        this.expanded.delete(node.key);
        this.readingRegion = "timeline";
      } else return;
      this.previewOffsets.set(node.key, this.previewOffset);
      this.following = false;
      this.tui.requestRender();
      return;
    }

    const move = (next: number, follow = false) => {
      const target = nodes[Math.max(0, Math.min(nodes.length - 1, next))];
      if (target) this.selectedKey = target.key;
      this.readingRegion = "timeline";
      this.following = follow;
      if (follow) this.pausedCount = 0;
      this.tui.requestRender();
    };
    if (this.keys.scrollUp(data)) move(index - 1);
    else if (this.keys.scrollDown(data)) move(index + 1);
    else if (matchesKey(data, "home")) move(0);
    else if (matchesKey(data, "end")) move(nodes.length - 1, true);
    else if (this.keys.pageUp(data) || this.keys.pageDown(data)) {
      this.following = false;
      const delta = this.keys.pageUp(data) ? -this.lastViewport : this.lastViewport;
      this.timelineScroll = Math.max(0, this.timelineScroll + delta);
      const physical = this.physicalRows(Math.max(1, this.lastWidth - 4));
      const first = physical[this.timelineScroll];
      if (first) {
        this.selectedKey = first.node.key;
        if (first.kind === "body") {
          this.readingRegion = "preview";
          this.previewOffset = first.bodyRow;
        }
      }
      this.tui.requestRender();
    } else if (matchesKey(data, "right")) {
      this.following = false;
      if (node.owner && node.step.kind === "agent" && !node.step.key.startsWith("child:")) {
        this.message = "O opens this child in its own viewer.";
      } else if (!this.expanded.has(node.key) && (node.step.children?.length || node.step.kind === "agent" || node.step.bodySections?.length)) {
        this.expanded.add(node.key);
      } else if (node.step.children?.length || node.step.kind === "agent") {
        const next = this.flatSteps().findIndex((entry) => entry.parentKey === node.step.key);
        if (next >= 0) this.selectedKey = this.flatSteps()[next]?.key;
        else this.message = node.step.kind === "agent" ? "Child transcript unavailable; o reads the spawn result." : "No text body available.";
      } else if (node.step.bodySections?.length) {
        this.previewOpen.add(node.key);
        this.readingRegion = "preview";
        this.previewOffset = this.previewOffsets.get(node.key) ?? 0;
      }
      this.tui.requestRender();
    } else if (matchesKey(data, "space")) {
      this.following = false;
      if (this.expanded.has(node.key) || this.previewOpen.has(node.key)) {
        this.expanded.delete(node.key);
        this.previewOpen.delete(node.key);
      } else if (node.step.children?.length || node.step.kind === "agent" || node.step.bodySections?.length) {
        this.expanded.add(node.key);
      }
      this.tui.requestRender();
    } else if (matchesKey(data, "left")) {
      this.following = false;
      if (this.expanded.has(node.key) || this.previewOpen.has(node.key)) {
        this.expanded.delete(node.key);
        this.previewOpen.delete(node.key);
      } else if (node.parentKey) {
        const parent = nodes.find((entry) => entry.step.key === node.parentKey);
        if (parent) this.selectedKey = parent.key;
      }
      this.tui.requestRender();
    } else if (matchesKey(data, "f")) this.cycleFilter();
  }

  private cycleFilter(): void {
    this.filterMode = this.filterMode === "all" ? "key" : this.filterMode === "key" ? "tools" : "all";
    this.following = false;
    const nodes = this.flatSteps();
    if (!nodes.some((node) => node.key === this.selectedKey)) this.selectedKey = nodes[0]?.key;
    this.tui.requestRender();
  }

  private rawBlockLines(block: TranscriptRawBlock, width: number): string[] {
    const mode = this.markdownMode();
    const signature = `${width}|${mode}|${block.sourceRevision}`;
    const cached = this.rawCache.get(block.key);
    if (cached?.signature === signature) return cached.lines;
    const message = block.message;
    const lines: string[] = [];
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content : extractText(message.content);
      lines.push(this.theme.fg("accent", "[User]"), ...this.rawLines(text.trim(), width, false));
    } else if (message.role === "assistant") {
      lines.push(this.theme.bold("[Assistant]"));
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
      if (text) lines.push(...(mode === "off" ? this.rawLines(text, width, false) : this.markdownMessage(message, text, width, false)));
      for (const call of message.content.filter((part) => part.type === "toolCall")) {
        if (call.type === "toolCall") lines.push(truncateToWidth(this.theme.fg("muted", `  [Tool: ${call.name}] ${JSON.stringify(call.arguments)}`), width));
      }
    } else if (message.role === "toolResult") {
      const { text, elided } = capResult(extractText(message.content).trim());
      lines.push(this.theme.fg(message.isError ? "error" : "dim", message.isError ? "[Result error]" : "[Result ok]"));
      lines.push(...(mode === "all" ? this.markdownMessage(message, text, width, false) : this.rawLines(text, width, false)));
      if (elided) lines.push(this.theme.fg("dim", truncationNote(elided)));
    } else if (message.role === "bashExecution") {
      const { text, elided } = capResult(message.output.trim());
      lines.push(this.theme.fg("muted", `$ ${message.command}`), ...this.rawLines(text, width, false));
      if (elided) lines.push(this.theme.fg("dim", truncationNote(elided)));
    } else if (message.role === "compactionSummary" || message.role === "branchSummary") {
      lines.push(this.theme.fg("muted", message.role === "compactionSummary" ? "[Compacted]" : "[Branch summary]"));
      lines.push(...this.rawLines(message.summary, width, false));
    } else if (message.role === "custom" && message.display) {
      lines.push(this.theme.fg("muted", `[${message.customType}]`));
      lines.push(...this.rawLines(typeof message.content === "string" ? message.content : extractText(message.content), width, false));
    }
    const safe = lines.map((line) => truncateToWidth(line, width));
    this.rawCache.set(block.key, { signature, lines: safe });
    return safe;
  }

  private rawPhysical(width: number): { block: TranscriptRawBlock; line: string }[] {
    const output: { block: TranscriptRawBlock; line: string }[] = [];
    for (const block of this.snapshot.raw) {
      for (const line of this.rawBlockLines(block, width)) output.push({ block, line });
      output.push({ block, line: this.theme.fg("dim", "───") });
    }
    return output;
  }

  private renderRawViewport(width: number, viewport: number): string[] {
    const rows = this.rawPhysical(width);
    if (rows.length === 0) return [this.theme.fg("dim", "Waiting for the first message…")];
    const max = Math.max(0, rows.length - viewport);
    if (this.following) this.rawScroll = max;
    this.rawScroll = Math.max(0, Math.min(max, this.rawScroll));
    return rows.slice(this.rawScroll, this.rawScroll + viewport).map((entry) => entry.line);
  }

  private handleRawInput(data: string): void {
    const rows = this.rawPhysical(Math.max(1, this.lastWidth - 4));
    const max = Math.max(0, rows.length - this.lastViewport);
    if (this.keys.scrollUp(data)) this.rawScroll = Math.max(0, this.rawScroll - 1);
    else if (this.keys.scrollDown(data)) this.rawScroll = Math.min(max, this.rawScroll + 1);
    else if (this.keys.pageUp(data)) this.rawScroll = Math.max(0, this.rawScroll - this.lastViewport);
    else if (this.keys.pageDown(data)) this.rawScroll = Math.min(max, this.rawScroll + this.lastViewport);
    else if (matchesKey(data, "home")) this.rawScroll = 0;
    else if (matchesKey(data, "end")) {
      this.rawScroll = max;
      this.following = true;
      this.pausedCount = 0;
      this.tui.requestRender();
      return;
    } else return;
    this.following = false;
    this.readingRegion = "raw";
    this.tui.requestRender();
  }

  private openDetail(): void {
    const node = this.focusedNode();
    if (!node) {
      this.message = "No text body available.";
      this.tui.requestRender();
      return;
    }
    if (node.step.kind === "rollup") {
      this.message = "Select a member to read its body.";
      this.expanded.add(node.key);
      this.tui.requestRender();
      return;
    }
    if (!node.step.bodySections?.length) {
      this.message = node.step.running ? "Waiting for output." : "No text body available.";
      this.tui.requestRender();
      return;
    }
    this.detailNode = node;
    this.detailKey = node.key;
    this.openLayer("detail");
    if (this.readingRegion === "preview") {
      const width = Math.max(1, this.lastWidth - 4);
      const row = this.previewRows(node, width)[this.previewOffset];
      const sourceLine = row?.kind === "body" ? (row.sourceLine ?? 0) : 0;
      this.layerScroll = this.detailDocument(width).sourceRows[sourceLine] ?? 0;
    }
  }

  private openLayer(layer: PagerLayer): void {
    this.layerOrigin = this.captureView();
    this.layer = layer;
    this.layerScroll = 0;
    this.stopArmed = false;
    this.following = false;
    this.tui.requestRender();
  }

  private currentDetailNode(): FlatStep | undefined {
    if (!this.detailKey) return this.detailNode;
    const current = this.flatSteps().find((node) => node.key === this.detailKey);
    if (current) this.detailNode = current;
    return current ?? this.detailNode;
  }

  private sectionMarkdown(section: { label: string; markdown: boolean }): boolean {
    const mode = this.markdownMode();
    if (mode === "off") return false;
    return section.markdown || (mode === "all" && section.label !== "Arguments");
  }

  private detailDocument(width: number): { lines: string[]; sourceRows: number[] } {
    const node = this.currentDetailNode();
    if (!node) return { lines: ["No text body available."], sourceRows: [0] };
    const sections = node.step.bodySections ?? [];
    const signature = `${width}|${this.markdownMode()}|${node.step.sourceRevision}|${sections.map((section) => section.text).join("|")}`;
    if (this.detailLinesCache?.signature === signature) return this.detailLinesCache;
    const lines: string[] = [];
    const sourceRows: number[] = [];
    for (const section of sections) {
      lines.push(this.theme.bold(section.label));
      const markdown = this.sectionMarkdown(section);
      if (markdown) {
        const start = lines.length;
        for (const _sourceLine of section.text.split("\n")) sourceRows.push(start);
        lines.push(...this.renderText(section.text, width, true, false));
      } else {
        for (const sourceLine of section.text.split("\n")) {
          sourceRows.push(lines.length);
          lines.push(...this.renderText(sourceLine, width, false, false));
        }
      }
      if (section.truncatedUpstream) lines.push(this.theme.fg("warning", "Source was truncated upstream; showing all retained text."));
      lines.push("");
    }
    this.detailLinesCache = { signature, lines, sourceRows };
    return this.detailLinesCache;
  }

  private detailLines(width: number): string[] {
    return this.detailDocument(width).lines;
  }

  private helpLines(width: number): string[] {
    if (this.helpLinesCache?.width === width) return this.helpLinesCache.lines;
    const action = this.canSteer()
      ? "Enter steer. x twice stops; any other key cancels confirmation. Esc closes this conversation."
      : "Steering unavailable for this conversation. Stop unavailable for this conversation. Esc closes this conversation.";
    const text = [
      `Viewing ${this.record.type}. Enter and x control this conversation, not an inline child.`,
      "Up/Down select (Raw: scroll). PgUp/PgDn page. Home first. End follow latest.",
      "Right expand; Right again enters children or preview. Space toggles. Left collapses or returns to parent.",
      "t opens/focuses Task; t again collapses. Task/Preview: arrows scroll, Home/End bounds. Left leaves Preview.",
      "Tab switches Steps/Raw at this position. m cycles raw, assistant Markdown, all Markdown.",
      "o reads full retained body here. O opens child.",
      action,
      "j/k move; Shift+Down/Up page. q or Ctrl+C closes the current layer. Configured navigation keys also work.",
      "f cycles All, errors+mutations, tools only.",
      "Right marker: collapsed. Down marker: expanded. Cursor marker: selected row.",
      this.invocationLine() ?? "",
      this.options.parent ? `Parent: ${this.options.parent.id} ${this.options.parent.description}` : "",
    ].filter(Boolean).join("\n\n");
    const lines = this.rawLines(text, width, false);
    this.helpLinesCache = { width, lines };
    return lines;
  }

  private renderPager(width: number): string[] {
    const innerWidth = width - 4;
    const allocated = Math.max(5, Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100));
    const viewport = Math.max(1, allocated - 4);
    const content = this.layer === "help" ? this.helpLines(innerWidth) : this.detailLines(innerWidth);
    const max = Math.max(0, content.length - viewport);
    this.layerScroll = Math.max(0, Math.min(max, this.layerScroll));
    const title = this.layer === "help"
      ? `Viewer keys · ${this.options.parent ? "child" : "conversation"}`
      : `Detail · ${this.record.type} · ${this.currentDetailNode()?.step.label ?? "step"}`;
    const range = `Lines ${content.length === 0 ? 0 : this.layerScroll + 1}-${Math.min(content.length, this.layerScroll + viewport)}/${content.length}`;
    const lines = [this.border(width, "top"), this.row(this.theme.bold(title), innerWidth)];
    for (let index = 0; index < viewport; index++) lines.push(this.row(content[this.layerScroll + index] ?? "", innerWidth));
    lines.push(this.row(wholeTokens(["Esc back", "? close help", range], innerWidth), innerWidth));
    lines.push(this.border(width, "bottom"));
    return lines.slice(0, allocated);
  }

  private handlePagerInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c") || (this.layer === "help" && matchesKey(data, "?"))) {
      const origin = this.layerOrigin;
      this.layer = undefined;
      this.detailNode = undefined;
      this.detailKey = undefined;
      if (origin) this.restoreView(origin);
      this.tui.requestRender();
      return;
    }
    const lines = this.layer === "help" ? this.helpLines(Math.max(1, this.lastWidth - 4)) : this.detailLines(Math.max(1, this.lastWidth - 4));
    const max = Math.max(0, lines.length - Math.max(1, this.lastViewport));
    if (this.keys.scrollUp(data)) this.layerScroll = Math.max(0, this.layerScroll - 1);
    else if (this.keys.scrollDown(data)) this.layerScroll = Math.min(max, this.layerScroll + 1);
    else if (this.keys.pageUp(data)) this.layerScroll = Math.max(0, this.layerScroll - Math.max(1, this.lastViewport));
    else if (this.keys.pageDown(data)) this.layerScroll = Math.min(max, this.layerScroll + Math.max(1, this.lastViewport));
    else if (matchesKey(data, "home")) this.layerScroll = 0;
    else if (matchesKey(data, "end")) this.layerScroll = max;
    else if (this.layer === "detail" && matchesKey(data, "m")) {
      const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
      this.markdownModeOverride = next;
      this.onMarkdownMode?.(next);
      this.detailLinesCache = undefined;
    } else return;
    this.tui.requestRender();
  }

  private openChild(): void {
    const node = this.focusedNode();
    if (!node) return;
    const resolutionParent = node.owner?.record ?? this.record;
    const resolutionKey = `${resolutionParent.id}:${node.step.key}`;
    let resolved = this.resolvedChildren.get(resolutionKey);
    if (!resolved && node.step.kind === "agent") {
      resolved = this.options.resolveChildren?.(resolutionParent, node.step) ?? [];
      if (resolved.length > 0) this.resolvedChildren.set(resolutionKey, resolved);
    }
    if (!node.owner && resolved && resolved.length > 1) {
      this.expanded.add(node.key);
      this.message = "Select a child, then press O.";
      this.following = false;
      this.tui.requestRender();
      return;
    }
    const target = node.owner && node.step.kind !== "agent" ? node.owner : (resolved?.[0] ?? node.owner);
    if (!target) {
      this.message = node.step.kind === "agent" ? "Child transcript unavailable; o reads the spawn result." : "No child for this step.";
      this.tui.requestRender();
      return;
    }
    const ancestors = [...(this.options.ancestorIds ?? []), this.record.id];
    if (ancestors.includes(target.record.id)) {
      this.message = "That conversation is already open.";
      this.tui.requestRender();
      return;
    }
    this.childOrigin = this.captureView();
    this.following = false;
    this.childViewer = new ConversationViewer(
      this.tui,
      target.session,
      target.record,
      target.activity,
      this.theme,
      () => this.closeChild(),
      target.onStop,
      undefined,
      target.onSteer,
      this.showCost,
      () => this.markdownMode(),
      this.onMarkdownMode,
      () => "steps",
      undefined,
      { ...this.options, parent: this.record, ancestorIds: ancestors, initialStepKey: node.owner ? node.step.key : undefined },
    );
    this.tui.requestRender();
  }

  private closeChild(): void {
    this.childViewer?.dispose();
    this.childViewer = undefined;
    if (this.childOrigin) this.restoreView({ ...this.childOrigin, following: false });
    this.tui.requestRender();
  }

  private headerLine(): string {
    const status = this.record.status;
    const icon = status === "running" ? this.theme.fg("accent", "●")
      : status === "completed" ? this.theme.fg("success", "✓")
      : status === "error" ? this.theme.fg("error", "✗") : this.theme.fg("dim", "○");
    const promptMode = getPromptModeLabel(this.record.type);
    const name = renderAgentName(this.record.type, this.theme, { bold: true });
    const mode = promptMode ? ` ${this.theme.fg("dim", `(${promptMode})`)}` : "";
    const follow = this.following ? "Following" : this.pausedCount > 0 ? `Paused +${this.pausedCount}` : "Paused";
    const parts: string[] = [follow, formatDuration(this.record.startedAt, this.record.completedAt)];
    const tools = this.activity?.toolUses ?? this.record.toolUses;
    if (tools > 0) parts.unshift(`${tools} tool${tools === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) parts.push(formatSessionTokens(tokens, getSessionContextPercent(this.activity?.session), this.theme, this.record.compactionCount));
    const cost = this.showCost ? formatCost(getLifetimeCost(this.record.lifetimeUsage)) : "";
    if (cost) parts.push(cost);
    const parent = this.options.parent ? ` · from ${this.options.parent.type}` : "";
    return `${icon} ${name}${mode}${parent}  ${this.record.description} ${this.theme.fg("dim", `· ${parts.join(" · ")}`)}`;
  }

  private invocationLine(): string | undefined {
    const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
    const model = modelId ?? modelName;
    const parts = model ? [model, ...tags] : tags;
    return parts.length > 0 ? this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`) : undefined;
  }

  private footer(width: number): string {
    if (this.composer) return wholeTokens(["Enter send", "Esc cancel"], width);
    if (this.stopArmed) return wholeTokens(["x again to STOP", this.options.parent ? "Esc back" : "Esc close"], width);
    const base = [this.options.parent ? "Esc back" : "Esc close", "? help"];
    if (this.isStoppable()) base.push("x stop");
    const optional = [
      this.viewMode() === "steps" ? "Tab raw" : "Tab steps",
      this.canSteer() ? "Enter steer" : "",
      this.readingRegion === "task" ? "↑↓ task" : this.viewMode() === "steps" ? "↑↓ select" : "↑↓ scroll",
    ].filter(Boolean);
    const status = this.message || (this.viewMode() === "steps" && this.filterMode !== "all" ? `filter: ${this.filterMode === "key" ? "errors+mutations" : "tools only"}` : "");
    return wholeTokens(status ? [...base, ...optional, status] : [...base, ...optional], width);
  }

  private border(width: number, edge: "top" | "bottom"): string {
    return this.theme.fg("border", `${edge === "top" ? "╭" : "╰"}${"─".repeat(width - 2)}${edge === "top" ? "╮" : "╯"}`);
  }

  private row(content: string, width: number): string {
    const clipped = truncateToWidth(content, width, "", true);
    return this.theme.fg("border", "│") + " " + clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))) + " " + this.theme.fg("border", "│");
  }

  private rawLines(text: string, width: number, dim: boolean): string[] {
    const lines = wrapTextWithAnsi(text, width);
    return dim ? lines.map((line) => this.theme.fg("dim", line)) : lines;
  }

  private markdownMessage(message: object, text: string, width: number, dim: boolean): string[] {
    let cached = this.markdownCache.get(message);
    if (!cached) {
      cached = {
        markdown: new Markdown(
          text,
          0,
          0,
          this.markdownTheme,
          dim ? { color: (value) => this.theme.fg("dim", value) } : undefined,
          MARKDOWN_OPTIONS,
        ),
        text,
        failed: false,
      };
      this.markdownCache.set(message, cached);
    } else if (cached.text !== text) {
      const retry = !text.startsWith(cached.text);
      cached.markdown.setText(text);
      cached.text = text;
      if (retry) cached.failed = false;
    }
    if (cached.failed) return this.rawLines(text, width, dim);
    try {
      return cached.markdown.render(width);
    } catch {
      cached.failed = true;
      return this.rawLines(text, width, dim);
    }
  }

  private markdownStandalone(text: string, width: number, dim: boolean): string[] {
    try {
      return new Markdown(
        text,
        0,
        0,
        this.markdownTheme,
        dim ? { color: (value) => this.theme.fg("dim", value) } : undefined,
        MARKDOWN_OPTIONS,
      ).render(width);
    } catch {
      return this.rawLines(text, width, dim);
    }
  }

  private renderText(text: string, width: number, markdown: boolean, dim: boolean): string[] {
    return markdown ? this.markdownStandalone(text, width, dim) : this.rawLines(text, width, dim);
  }

  private clearTextCaches(): void {
    this.taskCache = undefined;
    this.previewCache.clear();
    this.rawCache.clear();
    this.detailLinesCache = undefined;
    this.helpLinesCache = undefined;
  }

  /** Pure legacy full dump retained for direct regression tests only. */
  buildContentLines(width: number): string[] {
    if (width <= 0) return [];
    this.snapshot = this.model.sync(this.session.messages);
    const lines: string[] = [];
    for (const block of this.snapshot.raw) {
      lines.push(...this.rawBlockLines(block, width), this.theme.fg("dim", "───"));
    }
    if (lines.length === 0) lines.push(this.theme.fg("dim", "(waiting for first message...)"));
    if (this.record.status === "running" && this.activity) {
      const activity = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("", truncateToWidth(this.theme.fg("accent", "▍ ") + fgPreservingNestedStyles(this.theme, "dim", activity), width));
    }
    return lines.map((line) => truncateToWidth(line, width));
  }
}
