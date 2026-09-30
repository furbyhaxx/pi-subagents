// Persistence for pi-subagents operational settings.
// - User:    ~/.pi/agent/subagents.yaml (via getAgentDir()) — the default save target
// - Project: <cwd>/.pi/subagents.yaml — overrides user on load
//
// YAML, not JSON, and written through a document round-trip so a hand-authored
// file keeps its comments, key order and formatting. Writes are a PATCH of the
// keys that actually changed, never a whole-snapshot dump: with two layers, a
// snapshot written into one layer would freeze the other layer's value into it
// and drag along every setting the user never opened.
//
// A pre-YAML `subagents.json` is still read when no `subagents.yaml` sits
// beside it, and the first save migrates it in full. Migration is deliberately
// not done on load — see `readSettingsLayer`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Document, isMap, parse, parseDocument, type YAMLMap } from "yaml";
import { NO_FALLBACK } from "./agent-types.js";
import type { MessagingScopeMode } from "./messaging/scope.js";
import type { MessagingSurface } from "./messaging/types.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, ViewerViewMode, WidgetMode } from "./types.js";
import type { WorktreeDirectory } from "./worktree.js";

export interface MessagingSettings {
  enabled?: boolean;
  scope?: MessagingScopeMode;
  directory?: string;
  operatorTopicPrefix?: string;
  notifySocket?: string | false;
  maxWakesPerMinute?: number;
  maxHops?: number;
  messageTtlMs?: number;
  maxWaitMs?: number;
  mailboxLimit?: number;
  surface?: MessagingSurface;
  allowForeignMainWake?: boolean;
}

export interface SubagentsSettings {
  messaging?: MessagingSettings;
  /** Persistent artifact container; relative paths anchor to the origin project. New sessions only. */
  sessionArtifactDirectory?: string;
  /** Placement for future worktree acquisitions, independently of transcripts. */
  worktreeDirectory?: WorktreeDirectory;
  maxConcurrent?: number;
  /**
   * Max concurrent FOREGROUND (blocking) agents — `0` = unlimited, the default,
   * which preserves the behaviour that has always applied: nothing bounded
   * foreground work, and pi dispatches a message's tool calls through
   * `Promise.all`, so an unqualified fan-out of blocking `Agent` calls runs all
   * at once. Set it to bound that (#253 — on local models, parallel agents
   * thrash the prompt cache).
   *
   * Deliberately independent of `maxConcurrent` rather than folded into it: a
   * foreground agent blocks the parent anyway, so charging it to the background
   * pool would let a saturated pool starve the main session of work it could
   * have done itself.
   *
   * Bounds only spawns a caller is blocking on inline. Nested children are
   * exempt — their parent is blocked awaiting them, so queueing a child behind
   * its own parent would deadlock — and so are detached spawns from
   * cross-extension RPC or `@handle` mentions, which block nobody and are
   * documented to start immediately. Foreground `resume` is also outside the
   * pool: it reuses an existing session and never reaches the spawn path, so
   * several blocking resumes in one message can still exceed the limit.
   */
  maxConcurrentForeground?: number;
  /** Minutes of inactivity before a running agent is marked stalled. 0 disables the marker. Defaults to 5. */
  stallThresholdMinutes?: number;
  /**
   * 0 = unlimited — the extension's single source of truth for that convention:
   * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
   * `/agents` → Settings input prompt explicitly says "0 = unlimited".
   */
  defaultMaxTurns?: number;
  /** Pi session retries after the initial request for each selected model. Default 3. */
  maxRetries?: number;
  /** Additional complete traversals of an agent's ordered model list. Default 0. */
  maxModelWraparounds?: number;
  graceTurns?: number;
  defaultJoinMode?: JoinMode;
  /**
   * Whether a top-level `Agent` spawn that doesn't say runs detached.
   * Defaults to `true`, following Claude Code, where the agent backgrounds
   * unless the caller passes `run_in_background: false`. Set `false` to restore
   * the previous behaviour, where an unqualified spawn blocked the turn and
   * returned its result inline.
   *
   * Top-level only. Nested spawns (a subagent spawning its own) always default
   * to foreground regardless of this setting — see `nested-tools.ts`, where a
   * detached child would be killed by `abortOwnedChildren` when its parent
   * settles, with no notification path to deliver its result.
   *
   * An explicit `run_in_background` on the call, or in the agent file's
   * frontmatter, overrides this in both directions; the setting only decides
   * what "unspecified" means.
   */
  backgroundByDefault?: boolean;
  /**
   * Master switch for the schedule subagent feature. Defaults to `true`.
   * When `false`: the `Agent` tool's `schedule` param + its guideline are
   * stripped from the tool spec at registration (zero LLM-context cost), the
   * scheduler doesn't bind to the session, and the `/agents → Scheduled jobs`
   * menu entry is hidden. Schema-level removal applies at extension load
   * (next pi session); runtime menu/runtime-fire short-circuit is immediate.
   */
  schedulingEnabled?: boolean;
  /**
   * When true, the effective model of each subagent spawn is validated
   * against `enabledModels` from pi's settings — both global
   * (`<agentDir>/settings.json`) and project-local (`<cwd>/.pi/settings.json`),
   * with project overriding global (mirrors pi's SettingsManager deep-merge).
   *
   * scopeModels guards against runtime LLM choices, not user-level config.
   * Out-of-scope handling reflects this:
   *   - Caller-supplied via `Agent({ model: "..." })`: hard error returned to
   *     the orchestrator, listing the allowed models. An explicit caller model
   *     replaces any configured fallback list.
   *   - Frontmatter-configured: warning toast + the configured model runs. The
   *     agent's author/installer chose this; trust it.
   *   - Parent-inherited (neither caller nor frontmatter sets a model):
   *     warning toast + parent's model runs. The user chose the parent's
   *     model when starting the session; trust it.
   *
   * No-op when pi's `enabledModels` is empty or absent — nothing to validate
   * against. Defaults to false: subagents may use any model.
   */
  scopeModels?: boolean;
  /**
   * When true, an unreadable or unparseable agent `.md` aborts extension load
   * instead of being skipped with a warning — pi exits, naming the file.
   *
   * Startup only, by design. Mid-session reloads (one per `Agent` call) keep
   * warning: a bad edit at 3pm should not kill the session on the next
   * unrelated spawn, where the failure would look disconnected from its cause.
   * For a checked-in `.pi/agents/`, failing at startup is the point — the
   * alternative is running a *different* agent than the file names.
   * Defaults to false.
   */
  strictAgentFiles?: boolean;
  /**
   * When true, the three built-in default agents (general-purpose, Explore, Plan)
   * are not registered at startup. User-defined agents from project/global custom
   * agent dirs are completely unaffected — only the hardcoded DEFAULT_AGENTS are suppressed.
   * Defaults to false.
   */
  disableDefaultAgents?: boolean;
  /**
   * Which Agent tool description the LLM sees. "full" (default) is the rich
   * Claude Code-style prompt; "compact" is a ~75% smaller version (one-line
   * agent type list, terse usage notes) for small/local models where tool-spec
   * tokens are expensive; "custom" reads `.pi/agent-tool-description.md`
   * (project, falling back to `<agentDir>/agent-tool-description.md`) with
   * `{{placeholder}}` substitution — a missing/empty file falls back to "full".
   * The mode is read once at tool registration — changing it applies on the
   * next pi session.
   */
  toolDescriptionMode?: ToolDescriptionMode;
  /**
   * Whether the Claude Code-style FleetView (the navigable main+subagents list
   * rendered below the editor) is shown. Defaults to `true`. Pure-UI: when off,
   * the list never registers and the global key handler never captures input.
   */
  fleetView?: boolean;
  /**
   * Whether `@handle message` typed at the prompt is routed to that subagent
   * instead of the main model, and whether `@` offers running agents alongside
   * pi's file completion. Defaults to `model`. Applied live.
   *
   *   - `model`: mentioning an agent that is not running asks the main model to
   *     spawn it with the `Agent` tool, Claude Code's behaviour. Costs a turn,
   *     and the model writes the agent's prompt rather than your text being it.
   *   - `direct`: that agent is started here instead, with the typed message as
   *     its prompt and no main-model turn spent.
   *   - `off`: the input hook falls straight through and the stacked
   *     autocomplete provider delegates everything back to pi's built-in one.
   *
   * Messaging a running agent and resuming a finished one are direct in both
   * `model` and `direct`. The legacy booleans are still accepted: `true` reads
   * as `model`, `false` as `off`.
   */
  agentMentions?: AgentMentionMode;
  /**
   * Whether subagents persist their pi session by default, so `@handle` can
   * reopen an agent's conversation long after its in-memory record is gone.
   * Defaults to `true`. Per-agent `persist_session:` frontmatter overrides it
   * in both directions. Turning it off restores the previous behaviour, where
   * a handle stops resolving roughly ten minutes after the agent finishes and
   * mentioning it starts a fresh run instead. Persisted sessions also appear
   * nested under the spawning session in pi's `/resume`.
   */
  rememberAgents?: boolean;
  /**
   * Display mode for the persistent above-editor agent widget:
   *   - `all`: show every agent (foreground + background).
   *   - `background`: hide foreground agents — they already render inline as the
   *     Agent tool result, so the widget would otherwise double-render them
   *     (#118); everything else (background, queued, scheduled, RPC) stays.
   *   - `off`: hide the widget entirely.
   * Defaults to `background`. Pure-UI and applied live (toggling refreshes the
   * widget).
   */
  widgetMode?: WidgetMode;
  /**
   * Project/global default for writing each subagent's `.output` transcript
   * (a JSON-lines copy of the run, stored in the persistent session artifact directory).
   * Defaults to `true`. Set `false` to make transcripts opt-in for the whole
   * project (e.g. a repo that shouldn't leave run transcripts on disk for backup
   * or DLP tooling to ingest). A custom agent's `output_transcript` frontmatter
   * overrides this per agent. This governs only the transcript — it does NOT
   * affect the persisted pi session (`persist_session`), retained worktrees on
   * real branches, or memory files. Dirty work is committed only when
   * `worktreeAutoCommit` is enabled; the extension never pushes, merges or removes worktrees.
   */
  outputTranscript?: boolean;
  /**
   * Whether `isolation: "worktree"` may create a worktree at all. Defaults to
   * `true`. Set `false` on a repo where worktrees are too slow or too large to
   * be worth it (#184): the Agent schema and descriptions omit worktree options,
   * and stale or programmatic requests fail rather than running in the shared
   * checkout.
   *
   * `isolationParam` (invocation-config.ts) drops the field from both tool
   * schemas, and `isolationGuideline` (index.ts) drops the matching prose from
   * the full and compact descriptions — a custom description opts in through
   * the `{{isolationGuideline}}` placeholder. Runtime enforcement also covers
   * agent frontmatter, schedules and unvalidated cross-extension RPC calls.
   */
  worktreeIsolation?: boolean;
  /** Automatically stage and commit dirty worktrees when agents settle. Defaults to false. */
  worktreeAutoCommit?: boolean;
  /**
   * Master switch for scripted workflows. Defaults to `true`.
   *
   * Off is not a soft hide: the `SubagentWorkflow` tool is never registered, so
   * the model is not told it exists and cannot call it, the `/agents`
   * Workflows entry is hidden, and `--subagents-workflow-file` is refused.
   *
   * Absent is not the same as `true`. Unset means *auto*: on, but yielding to
   * another extension that already offers a workflow tool, because two
   * orchestrators in one tool spec is a worse default than none — the model
   * has to guess which to call, and pays for both descriptions to find out.
   * Setting it explicitly pins the answer in both directions: `true` keeps
   * ours whatever else is loaded, `false` is off regardless. See
   * `resolveWorkflowCollisions` in index.ts.
   *
   * Read once at extension init, before registration, so flipping it in
   * `/agents → Settings` takes effect on the next pi session — the same
   * contract `schedulingEnabled` has, and for the same reason: a tool spec is
   * fixed once pi has it.
   */
  workflowsEnabled?: boolean;
  /**
   * Hard ceiling on nested subagent delegation, counted from the main session:
   * main = 0, its subagents = 1, their children = 2. Defaults to `2`; `0` or `1`
   * disables nesting project-wide. Read when a subagent session is built, so a
   * change applies to agents started after it.
   */
  maxSubagentDepth?: number;
  /**
   * Agent type substituted when a caller-supplied `subagent_type` doesn't
   * resolve to exactly one enabled agent (unknown, disabled, or ambiguous by
   * case). Omitted keeps the historical `general-purpose` fallback; a type name
   * routes those calls to that agent instead; `"none"` disables the fallback so
   * dispatch fails closed with an error naming the available types.
   *
   * The boolean `false` is accepted as a spelling of `"none"`, because a boolean
   * would otherwise be dropped as the wrong type and silently leave the
   * PERMISSIVE default in place while the author believes strict dispatch is on
   * — the wrong direction to fail for this setting. Every other value is an
   * agent name, so a mistaken `"off"` fails loudly at dispatch rather than
   * meaning one thing here and another in the resolver.
   */
  fallbackSubagent?: string;
  /**
   * Whether this extension's tool results carry a `usage` field, so subagent
   * spend reaches the parent session's own accounting. Defaults to `false`.
   *
   * Subagents run in their own pi sessions, so by default the parent's footer,
   * statusline and `/cost` show only what the main model spent — a session that
   * delegated most of its work reads as nearly free. Pi folds
   * `toolResult.usage` into `getSessionStats()`, so attaching it makes those
   * surfaces count subagents too, under `/cost`'s "Tools/summaries" bucket.
   *
   * Off by default because it changes numbers the user may already be tracking
   * (a statusline reading session cost will step up), not because the numbers
   * are wrong.
   *
   * Three properties of what gets reported:
   *   - Tokens exclude `cacheRead`, for the reason in `usage.ts` — the parent's
   *     token total therefore rises by billed tokens only.
   *   - Cost is pi's own per-message `usage.cost.total`; we price nothing, and
   *     a model pi has no rates for contributes 0.
   *   - The context-window percentage is untouched. Pi derives it from assistant
   *     messages alone (`getContextUsage`), so a delegating session's context
   *     does not appear to fill up faster.
   */
  reportUsage?: boolean;
  /**
   * Whether the subagent surfaces show an estimated dollar cost next to their
   * token counts (widget, FleetView, conversation viewer, foreground results,
   * completion notifications). Defaults to `false`. Applied live.
   *
   * Rendered as `~$0.0042` — the tilde marks it as pi's reported estimate
   * rather than a billed figure, and it is omitted entirely when the model has
   * no pricing data, so a local model shows tokens and no dollars.
   *
   * Independent of `reportUsage`: this one is what a human reads, that one is
   * what the parent session counts.
   */
  showCost?: boolean;

  /**
   * Whether the widget's running rows name the model driving each agent and the
   * thinking level it is running at.
   *
   * Off by default, unlike the tool result and the conversation viewer, which
   * show the pair unconditionally: those have a line to themselves, while the
   * widget row already carries the description, turns, tool uses, tokens and
   * elapsed time, and every character it gains is one the description loses on a
   * narrow terminal.
   */
  showModel?: boolean;
  /**
   * How much of the conversation viewer's transcript renders as Markdown.
   * Defaults to `assistant`. Applied live — the viewer's `m` key cycles this
   * same setting, so a choice made in the overlay persists like one made in
   * `/agents → Settings`.
   *
   * Scoped rather than all-or-nothing because the two kinds of content have
   * different contracts: assistant text is authored as Markdown, while a tool
   * result is whatever bytes the tool produced. Rendering the latter as
   * Markdown is lossy in ways that look like the tool misbehaved — see
   * `ViewerMarkdownMode` for the specific rewrites — so `all` is opt-in.
   */
  viewerMarkdown?: ViewerMarkdownMode;
  /**
   * Which view the conversation viewer opens in. Defaults to `steps`. Applied
   * live — `Tab` in the viewer cycles this same setting.
   */
  viewerMode?: ViewerViewMode;
  /**
   * Command used to edit an agent's system prompt outside the TUI, e.g.
   * `code --wait` or `nvim`. Unset falls back to `$VISUAL` then `$EDITOR`, and
   * to the built-in inline editor when neither is set or the launch fails.
   *
   * Only ever applied to the prompt BODY — the external editor is handed the
   * body with the frontmatter stripped, so hand-editing YAML in a throwaway
   * buffer is not a way to break the file.
   */
  promptEditor?: string;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
  setSessionArtifactDirectory: (path: string | undefined) => void;
  setWorktreeDirectory: (value: WorktreeDirectory) => void;
  setMaxConcurrent: (n: number) => void;
  setMaxConcurrentForeground: (n: number) => void;
  setStallThresholdMinutes: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setMaxRetries: (n: number) => void;
  setMaxModelWraparounds: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setBackgroundByDefault: (b: boolean) => void;
  setSchedulingEnabled: (b: boolean) => void;
  setScopeModels: (enabled: boolean) => void;
  setStrictAgentFiles: (b: boolean) => void;
  setDisableDefaultAgents: (b: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetView: (b: boolean) => void;
  setAgentMentions: (mode: AgentMentionMode) => void;
  setRememberAgents: (b: boolean) => void;
  setWidgetMode: (mode: WidgetMode) => void;
  setOutputTranscript: (b: boolean) => void;
  setWorktreeIsolation: (b: boolean) => void;
  setWorktreeAutoCommit: (b: boolean) => void;
  setWorkflowsEnabled: (b: boolean) => void;
  setMaxSubagentDepth: (n: number) => void;
  setFallbackSubagent: (v: string | undefined) => void;
  setReportUsage: (b: boolean) => void;
  setShowCost: (b: boolean) => void;
  setShowModel: (b: boolean) => void;
  setViewerMarkdown: (mode: ViewerMarkdownMode) => void;
  setViewerMode: (mode: ViewerViewMode) => void;
  setPromptEditor: (command: string | undefined) => void;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_JOIN_MODES: ReadonlySet<string> = new Set<JoinMode>(["async", "group", "smart"]);
const VALID_TOOL_DESCRIPTION_MODES: ReadonlySet<string> = new Set<ToolDescriptionMode>(["full", "compact", "custom"]);
const VALID_WIDGET_MODES: ReadonlySet<string> = new Set<WidgetMode>(["all", "background", "off"]);
const VALID_VIEWER_MARKDOWN_MODES: ReadonlySet<string> = new Set<ViewerMarkdownMode>(["off", "assistant", "all"]);
const VALID_VIEWER_VIEW_MODES: ReadonlySet<string> = new Set<ViewerViewMode>(["steps", "raw"]);
const VALID_AGENT_MENTION_MODES: ReadonlySet<string> = new Set<AgentMentionMode>(["model", "direct", "off"]);
const VALID_MESSAGING_SCOPES: ReadonlySet<string> = new Set<MessagingScopeMode>(["project", "session"]);
const VALID_MESSAGING_SURFACES: ReadonlySet<string> = new Set<MessagingSurface>(["off", "ui", "context"]);

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const RETRY_CEILING = 100;
const WRAPAROUND_CEILING = 100;
const GRACE_TURNS_CEILING = 1_000;
const SUBAGENT_DEPTH_CEILING = 16;

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (r.messaging && typeof r.messaging === "object") {
    const rawMessaging = r.messaging as Record<string, unknown>;
    const messaging: MessagingSettings = {};
    if (typeof rawMessaging.enabled === "boolean") messaging.enabled = rawMessaging.enabled;
    if (typeof rawMessaging.scope === "string" && VALID_MESSAGING_SCOPES.has(rawMessaging.scope)) {
      messaging.scope = rawMessaging.scope as MessagingScopeMode;
    }
    if (typeof rawMessaging.directory === "string" && rawMessaging.directory.trim()) {
      messaging.directory = rawMessaging.directory.trim();
    }
    if (typeof rawMessaging.operatorTopicPrefix === "string" && rawMessaging.operatorTopicPrefix.trim()) {
      messaging.operatorTopicPrefix = rawMessaging.operatorTopicPrefix.trim();
    }
    if (rawMessaging.notifySocket === false) messaging.notifySocket = false;
    else if (typeof rawMessaging.notifySocket === "string" && rawMessaging.notifySocket.trim()) {
      messaging.notifySocket = rawMessaging.notifySocket.trim();
    }
    for (const key of ["maxWakesPerMinute", "maxHops", "messageTtlMs", "maxWaitMs", "mailboxLimit"] as const) {
      const value = rawMessaging[key];
      if (Number.isInteger(value) && (value as number) >= 0) messaging[key] = value as number;
    }
    if (typeof rawMessaging.surface === "string" && VALID_MESSAGING_SURFACES.has(rawMessaging.surface)) {
      messaging.surface = rawMessaging.surface as MessagingSurface;
    }
    if (typeof rawMessaging.allowForeignMainWake === "boolean") {
      messaging.allowForeignMainWake = rawMessaging.allowForeignMainWake;
    }
    out.messaging = messaging;
  }
  if (typeof r.sessionArtifactDirectory === "string" && r.sessionArtifactDirectory.trim()) {
    out.sessionArtifactDirectory = r.sessionArtifactDirectory;
  }
  if (r.worktreeDirectory && typeof r.worktreeDirectory === "object") {
    const value = r.worktreeDirectory as Record<string, unknown>;
    if (value.mode === "session" || value.mode === "project") out.worktreeDirectory = { mode: value.mode };
    else if (value.mode === "custom" && typeof value.path === "string" && value.path.trim()) {
      out.worktreeDirectory = { mode: "custom", path: value.path };
    }
  }
  if (
    Number.isInteger(r.maxConcurrent) &&
    (r.maxConcurrent as number) >= 1 &&
    (r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrent = r.maxConcurrent as number;
  }
  // Floor 0, not 1 like maxConcurrent above: 0 is the documented "unlimited"
  // value and the default, so dropping it would silently be unrepresentable.
  if (
    Number.isInteger(r.maxConcurrentForeground) &&
    (r.maxConcurrentForeground as number) >= 0 &&
    (r.maxConcurrentForeground as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrentForeground = r.maxConcurrentForeground as number;
  }
  if (Number.isInteger(r.stallThresholdMinutes) && (r.stallThresholdMinutes as number) >= 0) {
    out.stallThresholdMinutes = r.stallThresholdMinutes as number;
  }
  if (
    Number.isInteger(r.defaultMaxTurns) &&
    (r.defaultMaxTurns as number) >= 0 &&
    (r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
  ) {
    out.defaultMaxTurns = r.defaultMaxTurns as number;
  }
  if (
    Number.isInteger(r.maxRetries)
    && (r.maxRetries as number) >= 0
    && (r.maxRetries as number) <= RETRY_CEILING
  ) {
    out.maxRetries = r.maxRetries as number;
  }
  if (
    Number.isInteger(r.maxModelWraparounds)
    && (r.maxModelWraparounds as number) >= 0
    && (r.maxModelWraparounds as number) <= WRAPAROUND_CEILING
  ) {
    out.maxModelWraparounds = r.maxModelWraparounds as number;
  }
  if (
    Number.isInteger(r.graceTurns) &&
    (r.graceTurns as number) >= 1 &&
    (r.graceTurns as number) <= GRACE_TURNS_CEILING
  ) {
    out.graceTurns = r.graceTurns as number;
  }
  if (
    Number.isInteger(r.maxSubagentDepth) &&
    (r.maxSubagentDepth as number) >= 0 &&
    (r.maxSubagentDepth as number) <= SUBAGENT_DEPTH_CEILING
  ) {
    out.maxSubagentDepth = r.maxSubagentDepth as number;
  }
  if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode)) {
    out.defaultJoinMode = r.defaultJoinMode as JoinMode;
  }
  if (typeof r.backgroundByDefault === "boolean") {
    out.backgroundByDefault = r.backgroundByDefault;
  }
  if (typeof r.schedulingEnabled === "boolean") {
    out.schedulingEnabled = r.schedulingEnabled;
  }
  if (typeof r.scopeModels === "boolean") {
    out.scopeModels = r.scopeModels;
  }
  if (typeof r.strictAgentFiles === "boolean") {
    out.strictAgentFiles = r.strictAgentFiles;
  }
  if (typeof r.disableDefaultAgents === "boolean") {
    out.disableDefaultAgents = r.disableDefaultAgents;
  }
  if (typeof r.toolDescriptionMode === "string" && VALID_TOOL_DESCRIPTION_MODES.has(r.toolDescriptionMode)) {
    out.toolDescriptionMode = r.toolDescriptionMode as ToolDescriptionMode;
  }
  if (typeof r.fleetView === "boolean") {
    out.fleetView = r.fleetView;
  }
  // Was a boolean before the `model` mode existed. A hand-written or
  // previously-written `true` means "on", which is now the default `model`.
  if (typeof r.agentMentions === "boolean") {
    out.agentMentions = r.agentMentions ? "model" : "off";
  } else if (typeof r.agentMentions === "string" && VALID_AGENT_MENTION_MODES.has(r.agentMentions)) {
    out.agentMentions = r.agentMentions as AgentMentionMode;
  }
  if (typeof r.rememberAgents === "boolean") {
    out.rememberAgents = r.rememberAgents;
  }
  if (typeof r.widgetMode === "string" && VALID_WIDGET_MODES.has(r.widgetMode)) {
    out.widgetMode = r.widgetMode as WidgetMode;
  }
  if (typeof r.outputTranscript === "boolean") {
    out.outputTranscript = r.outputTranscript;
  }
  if (typeof r.worktreeIsolation === "boolean") {
    out.worktreeIsolation = r.worktreeIsolation;
  }
  if (typeof r.worktreeAutoCommit === "boolean") {
    out.worktreeAutoCommit = r.worktreeAutoCommit;
  }
  if (typeof r.reportUsage === "boolean") {
    out.reportUsage = r.reportUsage;
  }
  if (typeof r.showCost === "boolean") {
    out.showCost = r.showCost;
  }
  if (typeof r.showModel === "boolean") {
    out.showModel = r.showModel;
  }
  if (typeof r.viewerMarkdown === "string" && VALID_VIEWER_MARKDOWN_MODES.has(r.viewerMarkdown)) {
    out.viewerMarkdown = r.viewerMarkdown as ViewerMarkdownMode;
  }
  if (typeof r.viewerMode === "string" && VALID_VIEWER_VIEW_MODES.has(r.viewerMode)) {
    out.viewerMode = r.viewerMode as ViewerViewMode;
  }
  if (typeof r.promptEditor === "string" && r.promptEditor.trim()) {
    out.promptEditor = r.promptEditor.trim();
  }
  if (typeof r.workflowsEnabled === "boolean") {
    out.workflowsEnabled = r.workflowsEnabled;
  }
  if (r.fallbackSubagent === false) {
    // The only non-string spelling worth accepting: a boolean would otherwise be
    // dropped, silently leaving the PERMISSIVE default in place. Every string is
    // an agent name except the `none` sentinel, which the resolver recognizes —
    // so a mistaken "off" fails loudly at dispatch instead of meaning something
    // different here than it does there.
    out.fallbackSubagent = NO_FALLBACK;
  } else if (typeof r.fallbackSubagent === "string" && r.fallbackSubagent.trim()) {
    out.fallbackSubagent = r.fallbackSubagent.trim();
  }
  return out;
}

const SETTINGS_FILE = "subagents.yaml";
const LEGACY_SETTINGS_FILE = "subagents.json";

/** Which layer of the settings file stack an operation reads or writes. */
export type SettingsScope = "user" | "project";

/** Absolute path of one layer's settings file. */
export function settingsPath(scope: SettingsScope, cwd: string = process.cwd()): string {
  return scope === "user" ? join(getAgentDir(), SETTINGS_FILE) : join(cwd, ".pi", SETTINGS_FILE);
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    // `parse`, not `parseDocument(...).toJS()`: the document form collects
    // syntax errors instead of throwing, which would turn a typo in the file
    // into silently-default settings.
    const parsed: unknown = parse(readFileSync(path, "utf-8"));
    return sanitize(parsed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** A deprecated `subagents.json` already reported, so a reload does not repeat it. */
const warnedAboutJson = new Set<string>();

/**
 * Read one layer, falling back to a pre-YAML `subagents.json` beside it.
 *
 * The migration is deliberately NOT done here. Writing a file from a settings
 * *read* means every process that boots the extension — including one that only
 * wanted to look at a value — mutates the user's config directory, and a test
 * that boots without redirecting the agent dir would write to the developer's
 * real settings. So the JSON is read as-is and the file the user ends up with
 * is written on the first save: see `renderPatched`, which seeds the new YAML
 * from the JSON so nothing is lost in the crossing.
 */
function readSettingsLayer(scope: SettingsScope, cwd: string): SubagentsSettings {
  const path = settingsPath(scope, cwd);
  if (existsSync(path)) return readSettingsFile(path);

  const legacy = join(dirname(path), LEGACY_SETTINGS_FILE);
  if (!existsSync(legacy)) return {};
  const settings = readLegacyJson(legacy);
  if (Object.keys(settings).length > 0 && !warnedAboutJson.has(legacy)) {
    warnedAboutJson.add(legacy);
    console.warn(
      `[pi-subagents] ${legacy} is deprecated. It is still read, and the first settings save writes `
      + `${path} instead — delete the JSON once you have saved.`,
    );
  }
  return settings;
}

function readLegacyJson(path: string): SubagentsSettings {
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Load merged settings: the user layer provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsLayer("user", cwd), ...readSettingsLayer("project", cwd) };
}

/** Read a single layer, without the other one merged over it. */
export function readScopeSettings(scope: SettingsScope, cwd: string = process.cwd()): SubagentsSettings {
  return readSettingsLayer(scope, cwd);
}

/**
 * Merge `patch` into one layer's settings file and return whether the write
 * succeeded, so the caller can warn — persistence isn't fatal but isn't silent.
 *
 * A patch, not a snapshot, for the reason in the file header. `messaging` is
 * merged per key for the same reason: setting `messaging.enabled` must not
 * delete a `surface` the user set in that block, comments included.
 */
export function saveSettingsPatch(
  patch: SubagentsSettings,
  scope: SettingsScope,
  cwd: string = process.cwd(),
): boolean {
  const path = settingsPath(scope, cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderPatched(path, patch), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a patch to the file at `path`, preserving everything it does not touch.
 * A missing or unparseable file starts from an empty document — the latter
 * matches what the next load would see, so a typo in the file can't silently
 * swallow a save on top of itself.
 *
 * A missing YAML file next to a deprecated JSON one starts from THAT instead:
 * the one-time migration, done on the first save rather than on a read. Seeding
 * from the whole legacy layer is what keeps the crossing lossless — writing
 * only the patched key would drop every setting the user had not touched.
 */
function renderPatched(path: string, patch: SubagentsSettings): string {
  let doc: Document;
  if (existsSync(path)) {
    try {
      doc = parseDocument(readFileSync(path, "utf-8"));
      // `parseDocument` reports syntax errors on the document instead of
      // throwing. Writing a patch onto those would produce another broken file,
      // and the next load would drop every setting in it.
      if (doc.errors.length > 0) doc = new Document({});
    } catch {
      doc = new Document({});
    }
    if (doc.contents === null) doc.contents = doc.createNode({}) as Document["contents"];
  } else {
    const legacy = join(dirname(path), LEGACY_SETTINGS_FILE);
    const migrated = existsSync(legacy) ? readLegacyJson(legacy) : {};
    doc = new Document(migrated as Record<string, unknown>);
    warnedAboutJson.delete(legacy);
  }

  for (const [key, value] of Object.entries(patch)) {
    if (key === "messaging" && isRecord(value)) {
      const existing = doc.get(key, true);
      const block: YAMLMap = isMap(existing) ? existing : doc.createNode({}) as YAMLMap;
      for (const [subKey, subValue] of Object.entries(value)) {
        setOrDelete(block, subKey, subValue);
      }
      if (!doc.has(key)) doc.set(key, block);
    } else {
      setOrDelete(doc, key, value);
    }
  }
  return doc.toString({ lineWidth: 0 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An `undefined` value is a delete, not a write — it is how a key is unset. */
function setOrDelete(target: { set(key: string, value: unknown): unknown; delete(key: string): unknown }, key: string, value: unknown): void {
  if (value === undefined) target.delete(key);
  else target.set(key, value);
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (s.sessionArtifactDirectory !== undefined) appliers.setSessionArtifactDirectory(s.sessionArtifactDirectory);
  if (s.worktreeDirectory !== undefined) appliers.setWorktreeDirectory(s.worktreeDirectory);
  if (typeof s.maxConcurrent === "number") appliers.setMaxConcurrent(s.maxConcurrent);
  if (typeof s.maxConcurrentForeground === "number") {
    appliers.setMaxConcurrentForeground(s.maxConcurrentForeground);
  }
  if (typeof s.stallThresholdMinutes === "number") appliers.setStallThresholdMinutes(s.stallThresholdMinutes);
  if (typeof s.defaultMaxTurns === "number") appliers.setDefaultMaxTurns(s.defaultMaxTurns);
  if (typeof s.maxRetries === "number") appliers.setMaxRetries(s.maxRetries);
  if (typeof s.maxModelWraparounds === "number") {
    appliers.setMaxModelWraparounds(s.maxModelWraparounds);
  }
  if (typeof s.graceTurns === "number") appliers.setGraceTurns(s.graceTurns);
  if (typeof s.maxSubagentDepth === "number") appliers.setMaxSubagentDepth(s.maxSubagentDepth);
  if (typeof s.fallbackSubagent === "string") appliers.setFallbackSubagent(s.fallbackSubagent);
  if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
  if (typeof s.backgroundByDefault === "boolean") appliers.setBackgroundByDefault(s.backgroundByDefault);
  if (typeof s.schedulingEnabled === "boolean") appliers.setSchedulingEnabled(s.schedulingEnabled);
  if (typeof s.scopeModels === "boolean") appliers.setScopeModels(s.scopeModels);
  if (typeof s.strictAgentFiles === "boolean") appliers.setStrictAgentFiles(s.strictAgentFiles);
  if (typeof s.disableDefaultAgents === "boolean") appliers.setDisableDefaultAgents(s.disableDefaultAgents);
  if (s.toolDescriptionMode) appliers.setToolDescriptionMode(s.toolDescriptionMode);
  if (typeof s.fleetView === "boolean") appliers.setFleetView(s.fleetView);
  if (s.agentMentions) appliers.setAgentMentions(s.agentMentions);
  if (typeof s.rememberAgents === "boolean") appliers.setRememberAgents(s.rememberAgents);
  if (s.widgetMode) appliers.setWidgetMode(s.widgetMode);
  if (typeof s.outputTranscript === "boolean") appliers.setOutputTranscript(s.outputTranscript);
  if (typeof s.worktreeIsolation === "boolean") appliers.setWorktreeIsolation(s.worktreeIsolation);
  if (typeof s.worktreeAutoCommit === "boolean") appliers.setWorktreeAutoCommit(s.worktreeAutoCommit);
  if (typeof s.reportUsage === "boolean") appliers.setReportUsage(s.reportUsage);
  if (typeof s.showCost === "boolean") appliers.setShowCost(s.showCost);
  if (typeof s.showModel === "boolean") appliers.setShowModel(s.showModel);
  if (s.viewerMarkdown) appliers.setViewerMarkdown(s.viewerMarkdown);
  if (s.viewerMode) appliers.setViewerMode(s.viewerMode);
  if (s.promptEditor !== undefined) appliers.setPromptEditor(s.promptEditor);
  if (typeof s.workflowsEnabled === "boolean") appliers.setWorkflowsEnabled(s.workflowsEnabled);
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of the write into the right message + level so
 * the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

/**
 * Persist a settings patch, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * and `scope` fields so listeners can react to a write failure, or to which
 * layer the change landed in.
 *
 * The payload's `settings` is the whole file after the patch, not the patch:
 * a listener that only ever sees a diff cannot answer "what is effective now".
 */
export function saveAndEmitChanged(
  patch: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  scope: SettingsScope,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettingsPatch(patch, scope, cwd);
  emit("subagents:settings_changed", { settings: loadSettings(cwd), persisted, scope });
  return persistToastFor(successMsg, persisted);
}
