import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type TranscriptMessage = AgentSession["messages"][number];

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "glob",
  "ls",
  "list",
  "web_search",
  "web_fetch",
  "web_search_results",
]);
const MUTATING_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "patch",
  "apply_patch",
  "bash",
  "run_command",
]);
const FILE_WRITE_TOOLS = new Set(["edit", "write", "multiedit", "patch", "apply_patch"]);
const AGENT_TOOLS = new Set(["Agent", "SubagentWorkflow", "TaskExecute"]);
const INHERITED_TASK_MARKER = "# Your Task (below)";
const WORKTREE_SCOPE = "<worktree_scope>";
const TARGET_MAX = 240;

export type StepKind = "text" | "tool" | "rollup" | "agent" | "bash" | "compaction" | "steer" | "error";

export interface TranscriptBodySection {
  label: "Arguments" | "Result" | "Text";
  text: string;
  markdown: boolean;
  truncatedUpstream?: boolean;
}

export interface TranscriptStep {
  key: string;
  sourceId: string;
  sourceRevision: number;
  kind: StepKind;
  at?: number;
  label: string;
  target?: string;
  outcome?: string;
  durationMs?: number;
  isError?: boolean;
  running?: boolean;
  body?: string;
  bodySections?: readonly TranscriptBodySection[];
  children?: readonly TranscriptStep[];
  parentKey?: string;
  summary?: string;
  toolCallId?: string;
  childAgentIds?: readonly string[];
}

export interface TranscriptRawBlock {
  key: string;
  sourceId: string;
  sourceRevision: number;
  message: TranscriptMessage;
  stepKeys: readonly string[];
}

export interface TranscriptSnapshot {
  task?: string;
  steps: readonly TranscriptStep[];
  tail: readonly TranscriptStep[];
  raw: readonly TranscriptRawBlock[];
  generation: number;
  contentRevision: number;
}

type Source = {
  id: string;
  message: TranscriptMessage;
  signature: string;
  revision: number;
  provisional: boolean;
};

type TaskRecord = { taskPrompt?: string };

type TaskMetadata = { prompt?: unknown };

type ToolResultDetails = { agentId?: unknown; childAgentId?: unknown };

type TextBearingContent = string | readonly { type: string; text?: string }[];

function textContent(content: TextBearingContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function firstLine(text: string, max = TARGET_MAX): string | undefined {
  const line = text.split("\n").find((candidate) => candidate.trim())?.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function formatAssistantError(text: string): string {
  const jsonStart = text.search(/\{|\[/);
  if (jsonStart < 0) return text;
  try {
    return text.slice(0, jsonStart) + JSON.stringify(JSON.parse(text.slice(jsonStart)), null, 2);
  } catch {
    return text;
  }
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function messageSignature(message: TranscriptMessage): string {
  switch (message.role) {
    case "assistant":
      return `${message.role}|${message.timestamp}|${message.stopReason}|${message.errorMessage ?? ""}|${message.content
        .map((part) => {
          if (part.type === "text") return `t:${part.text}`;
          if (part.type === "thinking") return `h:${part.thinking}`;
          return `c:${part.id}:${part.name}:${stableStringify(part.arguments)}`;
        })
        .join("|")}`;
    case "toolResult":
      return `${message.role}|${message.toolCallId}|${message.toolName}|${message.isError}|${textContent(message.content)}|${stableStringify(message.details)}`;
    case "bashExecution":
      return `${message.role}|${message.timestamp}|${message.command}|${message.output}|${message.exitCode}|${message.truncated}`;
    case "custom":
      return `${message.role}|${message.timestamp}|${message.customType}|${textContent(message.content)}`;
    case "compactionSummary":
      return `${message.role}|${message.timestamp}|${message.tokensBefore}|${message.summary}`;
    case "branchSummary":
      return `${message.role}|${message.timestamp}|${message.fromId}|${message.summary}`;
    case "system":
      return `${message.role}|${message.timestamp}|${textContent(message.content)}|${stableStringify(message.sections)}|${stableStringify(message.toolsAdded)}`;
    case "user":
      return `${message.role}|${message.timestamp}|${textContent(message.content)}`;
  }
}

function sourceSemanticIdentity(message: TranscriptMessage): string | undefined {
  if (message.role === "toolResult") return `result:${message.toolCallId}`;
  if (message.role === "assistant") {
    const call = message.content.find((part) => part.type === "toolCall");
    if (call?.type === "toolCall") return `assistant:${call.id}`;
  }
  return undefined;
}

function sourceIdentity(message: TranscriptMessage, fallback: string): string {
  return sourceSemanticIdentity(message) ?? fallback;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function toolTarget(name: string, args: Record<string, unknown> = {}): string | undefined {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return firstLine(value);
      if (typeof value === "number") return String(value);
      if (Array.isArray(value) && value.length > 0) return firstLine(value.map(String).join(", "));
    }
    return undefined;
  };
  switch (name) {
    case "bash":
    case "run_command":
      return pick("command", "cmd");
    case "read":
    case "write":
    case "edit":
    case "multiedit":
      return pick("path", "file_path", "filePath");
    case "grep": {
      const pattern = pick("pattern", "query");
      const where = pick("path", "glob");
      return pattern && where ? `${pattern}  ${where}` : (pattern ?? where);
    }
    case "find":
    case "glob":
    case "ls":
      return pick("pattern", "path", "glob");
    case "Agent": {
      const type = pick("subagent_type", "agentType");
      const what = pick("description", "prompt");
      return type && what ? `${type} · ${what}` : (type ?? what);
    }
    case "SubagentWorkflow":
      return pick("name", "scriptPath", "description");
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskExecute":
      return pick("subject", "taskId", "task_ids", "status");
    default:
      return pick("description", "query", "prompt", "path", "name", "url", "pattern")
        ?? Object.values(args).find((value): value is string => typeof value === "string" && !!value.trim());
  }
}

function shortTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 999_950) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function originalTaskText(text: string): string {
  const marker = text.indexOf(INHERITED_TASK_MARKER);
  const candidate = marker >= 0 ? text.slice(marker + INHERITED_TASK_MARKER.length) : text;
  const scope = candidate.indexOf(WORKTREE_SCOPE);
  return (scope >= 0 ? candidate.slice(0, scope) : candidate).trim();
}

function rollupSummary(children: readonly TranscriptStep[]): string {
  const counts = new Map<string, number>();
  for (const child of children) counts.set(child.label, (counts.get(child.label) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(" · ");
}

function bodyForCall(args: Record<string, unknown>, result?: string, resultTruncated?: boolean): TranscriptBodySection[] {
  const sections: TranscriptBodySection[] = [];
  if (Object.keys(args).length > 0) sections.push({ label: "Arguments", text: stableStringify(args), markdown: false });
  if (result !== undefined) {
    sections.push({ label: "Result", text: result, markdown: false, truncatedUpstream: resultTruncated });
  }
  return sections;
}

function childIds(details: unknown): string[] {
  const record = objectRecord(details) as ToolResultDetails | undefined;
  const candidates = [record?.agentId, record?.childAgentId];
  return candidates.filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function isKeyStep(step: TranscriptStep): boolean {
  if (step.isError) return true;
  if (step.kind === "rollup") return false;
  if (step.kind === "tool") return MUTATING_TOOLS.has(step.label);
  return true;
}

export function isToolStep(step: TranscriptStep): boolean {
  return step.kind === "tool" || step.kind === "agent" || step.kind === "bash" || step.kind === "rollup";
}

export function isFileWriteTool(name: string): boolean {
  return FILE_WRITE_TOOLS.has(name);
}

/**
 * Incremental transcript index. Historical entries are loaded once. Live event
 * updates replace only the source block they identify; ordinary renders only
 * read the immutable snapshot.
 */
export class TranscriptModel {
  private readonly sources: Source[] = [];
  private readonly sourceById = new Map<string, Source>();
  private readonly persistedSignatures = new Set<string>();
  private readonly objectIds = new WeakMap<object, string>();
  private readonly activeLiveIds = new Map<TranscriptMessage["role"], string>();
  private nextObjectId = 1;
  private taskText: string | undefined;
  private exactTask: string | undefined;
  private generation = 0;
  private contentRevision = 0;
  private snapshot: TranscriptSnapshot = { steps: [], tail: [], raw: [], generation: 0, contentRevision: 0 };
  private dirty = true;

  constructor(entries: readonly SessionEntry[] = [], record?: TaskRecord) {
    this.exactTask = record?.taskPrompt?.trim() || undefined;
    this.loadBranch(entries);
  }

  loadBranch(entries: readonly SessionEntry[]): void {
    let changed = false;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "subagents:task") {
        const prompt = (entry.data as TaskMetadata | undefined)?.prompt;
        if (!this.exactTask && typeof prompt === "string" && prompt.trim()) this.exactTask = prompt.trim();
        continue;
      }
      if (entry.type === "custom_message" && entry.customType === "subagents:task") {
        const prompt = (entry.details as TaskMetadata | undefined)?.prompt;
        const text = typeof entry.content === "string" ? entry.content : undefined;
        if (!this.exactTask && typeof prompt === "string" && prompt.trim()) this.exactTask = prompt.trim();
        else if (!this.exactTask && text?.trim()) this.exactTask = text.trim();
        continue;
      }
      if (entry.type === "message") {
        changed = this.upsert(entry.id, entry.message, false) || changed;
      } else if (entry.type === "compaction") {
        const message: TranscriptMessage = {
          role: "compactionSummary",
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: Date.parse(entry.timestamp),
        };
        changed = this.upsert(entry.id, message, false) || changed;
      } else if (entry.type === "branch_summary") {
        const message: TranscriptMessage = {
          role: "branchSummary",
          summary: entry.summary,
          fromId: entry.fromId,
          timestamp: Date.parse(entry.timestamp),
        };
        changed = this.upsert(entry.id, message, false) || changed;
      } else if (entry.type === "custom_message") {
        const message: TranscriptMessage = {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          details: entry.details,
          timestamp: Date.parse(entry.timestamp),
        };
        changed = this.upsert(entry.id, message, false) || changed;
      } else if (entry.type === "custom" && entry.data !== undefined) {
        const message: TranscriptMessage = {
          role: "custom",
          customType: entry.customType,
          content: stableStringify(entry.data),
          display: true,
          details: entry.data,
          timestamp: Date.parse(entry.timestamp),
        };
        changed = this.upsert(entry.id, message, false) || changed;
      }
    }
    if (changed) this.rebuild();
  }

  /** Initial compatibility path for sessions/test doubles without history. */
  sync(messages: readonly TranscriptMessage[]): TranscriptSnapshot {
    let changed = false;
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const object = message as object;
      let id = this.objectIds.get(object);
      if (!id) {
        id = sourceIdentity(message, `memory:${this.nextObjectId++}`);
        this.objectIds.set(object, id);
      }
      if (this.sourceById.has(id)) {
        changed = this.upsert(id, message, true) || changed;
        continue;
      }
      if (this.hasPersistedEquivalent(message)) continue;
      changed = this.upsert(id, message, true) || changed;
    }
    if (changed) this.rebuild();
    return this.current();
  }

  handleEvent(event: AgentSessionEvent): TranscriptSnapshot {
    if (event.type === "entry_appended") {
      this.loadBranch([event.entry]);
      return this.current();
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      const message: TranscriptMessage = {
        role: "compactionSummary",
        summary: event.result.summary,
        tokensBefore: event.result.tokensBefore,
        timestamp: this.latestTimestamp() + 1,
      };
      this.upsert(`compaction:${event.result.firstKeptEntryId}:${event.result.tokensBefore}`, message, true);
      this.rebuild();
      return this.current();
    }
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const message = event.message;
      const id = this.liveSourceId(event.type, message);
      if (this.upsert(id, message, true)) this.rebuild();
      if (event.type === "message_end") this.activeLiveIds.delete(message.role);
      return this.current();
    }
    return this.current();
  }

  private latestTimestamp(): number {
    for (let index = this.sources.length - 1; index >= 0; index--) {
      const timestamp = this.sources[index]?.message.timestamp;
      if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
    }
    return 0;
  }

  private liveSourceId(eventType: "message_start" | "message_update" | "message_end", message: TranscriptMessage): string {
    const object = message as object;
    const existingObjectId = this.objectIds.get(object);
    if (existingObjectId) return existingObjectId;

    if (eventType !== "message_start") {
      const activeId = this.activeLiveIds.get(message.role);
      if (activeId) {
        this.objectIds.set(object, activeId);
        return activeId;
      }
    }

    const semanticId = sourceSemanticIdentity(message);
    const id = semanticId ?? `live:${this.nextObjectId++}`;
    this.objectIds.set(object, id);
    if (eventType === "message_start") this.activeLiveIds.set(message.role, id);
    return id;
  }

  current(): TranscriptSnapshot {
    if (this.dirty) this.rebuild();
    return this.snapshot;
  }

  private upsert(id: string, message: TranscriptMessage, provisional: boolean): boolean {
    const existing = this.sourceById.get(id);
    if (existing) {
      const signature = messageSignature(message);
      if (existing.signature === signature && existing.provisional === provisional) return false;
      existing.message = message;
      existing.signature = signature;
      existing.revision++;
      existing.provisional = provisional;
      if (!provisional) this.persistedSignatures.add(signature);
      this.contentRevision++;
      this.dirty = true;
      return true;
    }

    if (!provisional) {
      const duplicate = this.sources.find((source) => source.provisional && messageSignature(source.message) === messageSignature(message));
      if (duplicate) {
        this.sourceById.delete(duplicate.id);
        duplicate.id = id;
        duplicate.message = message;
        duplicate.signature = messageSignature(message);
        duplicate.provisional = false;
        duplicate.revision++;
        this.sourceById.set(id, duplicate);
        this.persistedSignatures.add(duplicate.signature);
        this.contentRevision++;
        this.dirty = true;
        return true;
      }
    }

    const source = { id, message, signature: messageSignature(message), revision: 0, provisional };
    this.sources.push(source);
    this.sourceById.set(id, source);
    if (!provisional) this.persistedSignatures.add(source.signature);
    this.generation++;
    this.contentRevision++;
    this.dirty = true;
    return true;
  }

  private hasPersistedEquivalent(message: TranscriptMessage): boolean {
    return this.persistedSignatures.has(messageSignature(message));
  }

  private rebuild(): void {
    const rawSteps: TranscriptStep[] = [];
    const rawBlocks: TranscriptRawBlock[] = [];
    const calls = new Map<string, TranscriptStep>();
    const knownCallIds = new Set<string>();
    const results = new Map<string, Extract<TranscriptMessage, { role: "toolResult" }>>();
    let fallbackTask: string | undefined;

    for (const source of this.sources) {
      const message = source.message;
      if (message.role === "toolResult") results.set(message.toolCallId, message);
      else if (message.role === "assistant") {
        for (const part of message.content) if (part.type === "toolCall") knownCallIds.add(part.id);
      }
    }

    for (const source of this.sources) {
      const message = source.message;
      const stepKeys: string[] = [];
      const push = (step: TranscriptStep) => {
        rawSteps.push(step);
        stepKeys.push(step.key);
      };
      if (message.role === "user") {
        const text = textContent(message.content).trim();
        if (text && fallbackTask === undefined) fallbackTask = originalTaskText(text);
        else if (text) push({
          key: `${source.id}:steer`, sourceId: source.id, sourceRevision: source.revision,
          kind: "steer", at: message.timestamp, label: "steer", target: firstLine(text), body: text,
          bodySections: [{ label: "Text", text, markdown: false }],
        });
      } else if (message.role === "assistant") {
        for (let index = 0; index < message.content.length; index++) {
          const part = message.content[index];
          if (part.type === "text" || part.type === "thinking") {
            const text = part.type === "text" ? part.text : part.thinking;
            if (!text.trim()) continue;
            push({
              key: `${source.id}:${part.type}:${index}`, sourceId: source.id, sourceRevision: source.revision,
              kind: "text", at: message.timestamp, label: part.type === "thinking" ? "reasoning" : "note",
              target: firstLine(text), body: text, bodySections: [{ label: "Text", text, markdown: true }],
            });
            continue;
          }
          const result = results.get(part.id);
          const resultText = result ? textContent(result.content) : undefined;
          const args = part.arguments ?? {};
          const ids = result ? childIds(result.details) : [];
          const resumeId = part.name === "Agent" && typeof args.resume === "string" ? args.resume : undefined;
          if (resumeId && !ids.includes(resumeId)) ids.push(resumeId);
          const isError = result?.isError ?? false;
          const step: TranscriptStep = {
            key: `call:${part.id}`, sourceId: source.id, sourceRevision: source.revision,
            kind: AGENT_TOOLS.has(part.name) ? "agent" : "tool", at: message.timestamp,
            label: part.name, target: toolTarget(part.name, args), outcome: resultText ? firstLine(resultText) : undefined,
            isError, running: !result, body: bodyForCall(args, resultText, false).map((section) => section.text).join("\n\n"),
            bodySections: bodyForCall(args, resultText, false), toolCallId: part.id,
            childAgentIds: ids.length > 0 ? ids : undefined,
          };
          calls.set(part.id, step);
          push(step);
        }
        if (message.errorMessage) {
          const body = formatAssistantError(message.errorMessage);
          push({
            key: `${source.id}:error`, sourceId: source.id, sourceRevision: source.revision,
            kind: "error", at: message.timestamp, label: "assistant error", target: firstLine(message.errorMessage),
            outcome: "error", isError: true, body,
            bodySections: [{ label: "Text", text: body, markdown: false }],
          });
        }
      } else if (message.role === "toolResult" && !knownCallIds.has(message.toolCallId)) {
        const text = textContent(message.content);
        push({
          key: `orphan:${message.toolCallId}`, sourceId: source.id, sourceRevision: source.revision,
          kind: "tool", at: message.timestamp, label: message.toolName || "unknown result",
          outcome: firstLine(text) ?? (message.isError ? "error" : "ok"), isError: message.isError,
          body: text, bodySections: [{ label: "Result", text, markdown: false }], toolCallId: message.toolCallId,
          childAgentIds: childIds(message.details),
        });
      } else if (message.role === "compactionSummary") {
        push({
          key: `${source.id}:compaction`, sourceId: source.id, sourceRevision: source.revision,
          kind: "compaction", at: message.timestamp, label: "compacted",
          outcome: `${shortTokens(message.tokensBefore)} tokens summarized`, body: message.summary,
          bodySections: [{ label: "Text", text: message.summary, markdown: false }],
        });
      } else if (message.role === "branchSummary") {
        push({
          key: `${source.id}:branch`, sourceId: source.id, sourceRevision: source.revision,
          kind: "compaction", at: message.timestamp, label: "branch", outcome: "returned from a branch",
          body: message.summary, bodySections: [{ label: "Text", text: message.summary, markdown: false }],
        });
      } else if (message.role === "bashExecution") {
        push({
          key: `${source.id}:bash`, sourceId: source.id, sourceRevision: source.revision,
          kind: "bash", at: message.timestamp, label: "bash", target: firstLine(message.command),
          outcome: firstLine(message.output), isError: message.exitCode !== undefined && message.exitCode !== 0,
          body: message.output, bodySections: [
            { label: "Arguments", text: message.command, markdown: false },
            { label: "Result", text: message.output, markdown: false, truncatedUpstream: message.truncated },
          ],
        });
      } else if (message.role === "custom" && message.display) {
        const text = textContent(message.content).trim();
        if (text) push({
          key: `${source.id}:custom`, sourceId: source.id, sourceRevision: source.revision,
          kind: message.customType.includes("error") ? "error" : "steer", at: message.timestamp,
          label: message.customType, target: firstLine(text), isError: message.customType.includes("error"), body: text,
          bodySections: [{ label: "Text", text, markdown: false }],
        });
      }
      rawBlocks.push({
        key: source.id,
        sourceId: source.id,
        sourceRevision: source.revision,
        message,
        stepKeys,
      });
    }

    const display: TranscriptStep[] = [];
    for (const step of rawSteps) {
      if (step.kind === "tool" && !step.running && !step.isError && READ_ONLY_TOOLS.has(step.label)) {
        const last = display.at(-1);
        if (last?.kind === "rollup" && last.children) {
          const children = [...last.children, { ...step, parentKey: last.key }];
          last.children = children;
          last.summary = rollupSummary(children);
          last.durationMs = children.reduce((sum, child) => sum + (child.durationMs ?? 0), 0);
        } else {
          const key = `rollup:${step.key}`;
          const child = { ...step, parentKey: key };
          display.push({
            key, sourceId: step.sourceId, sourceRevision: step.sourceRevision, kind: "rollup", at: step.at,
            label: "steps", children: [child], summary: rollupSummary([child]), durationMs: step.durationMs,
          });
        }
      } else {
        display.push(step);
      }
    }

    this.taskText = this.exactTask ?? fallbackTask;
    this.snapshot = {
      task: this.taskText,
      steps: display,
      tail: [],
      raw: rawBlocks,
      generation: this.generation,
      contentRevision: this.contentRevision,
    };
    this.dirty = false;
  }
}
