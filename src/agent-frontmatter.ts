/**
 * agent-frontmatter.ts — an agent `.md` frontmatter as a field model, for the
 * `/agents` definition editor.
 *
 * Two properties this module is built around:
 *
 * - **Round-trip, not re-serialize.** `applyAgentFields` patches the parsed
 *   document and splices it back, so comments, key order, unknown keys and
 *   the file's line endings survive an edit. The README tells users to
 *   hand-author these files, so a form that rewrote the block from scratch
 *   would eat exactly the parts a hand-author writes.
 * - **One table, two directions.** `AGENT_FIELDS` declares each key's kind and
 *   options once; the reader, the writer and the editor's widget all derive
 *   from it, so a field cannot be editable in the UI but unwritable, or
 *   writable but not shown.
 *
 * The reader parses with `parseAgentFrontmatter`, the same call the loader in
 * `custom-agents.ts` uses, so the form shows what will actually load — not
 * what a second, subtly different parser thinks the file says.
 */

import { Document, parseDocument } from "yaml";
import { splitFrontmatter } from "./agent-file-toggle.js";
import { parseAgentFrontmatter } from "./custom-agents.js";
import { MODEL_THINKING_LEVELS } from "./model-resolver.js";

export type AgentFieldKind =
  | "text"
  | "color"
  | "boolean"
  | "integer"
  | "choice"
  | "tools"
  | "inherit"
  | "list"
  | "subagents"
  | "models";

/** A field's value. `undefined` means "key absent" — distinct from a false or empty one. */
export type AgentFieldValue = string | number | boolean | string[] | undefined;

export interface AgentFieldSpec {
  /** The frontmatter key this field owns. */
  key: string;
  /** Label shown in the editor. */
  label: string;
  kind: AgentFieldKind;
  /** One line explaining what the field does, rendered under the label. */
  hint: string;
  /** Fixed options for `choice`; the editor adds its own "default" entry. */
  options?: readonly string[];
  /** Legacy spellings the loader still accepts. Cleared when this field is written. */
  aliases?: readonly string[];
}

/** Ordered as the editor presents them: identity, then what it can do, then how it runs. */
export const AGENT_FIELDS: readonly AgentFieldSpec[] = [
  {
    key: "name",
    label: "Name",
    kind: "text",
    hint: "The agent type callers pass as subagent_type. May not contain a colon. Defaults to the filename.",
  },
  {
    key: "display_name",
    label: "Display name",
    kind: "text",
    hint: "Badge shown in the UI when this differs from the type name.",
  },
  {
    key: "description",
    label: "Description",
    kind: "text",
    hint: "One line the model reads when choosing an agent. Defaults to the type name.",
  },
  {
    key: "color",
    label: "Color",
    kind: "color",
    hint: "Badge color: a name, an Agency Agents alias, or a #RRGGBB value.",
  },
  {
    key: "enabled",
    label: "Enabled",
    kind: "boolean",
    hint: "Off removes the type from dispatch without deleting the file.",
  },
  { key: "tools", label: "Tools", kind: "tools", hint: "Built-in tools the agent may use, `ext:` selectors, or nothing at all." },
  { key: "models", label: "Models", kind: "models", hint: "Ordered model candidates, tried in order with retries. Unset inherits the parent's model.", aliases: ["model"] },
  { key: "thinking", label: "Thinking level", kind: "choice", options: MODEL_THINKING_LEVELS, hint: "Unset inherits the caller's level." },
  { key: "max_turns", label: "Max turns", kind: "integer", hint: "0 = unlimited (the default)." },
  {
    key: "prompt_mode",
    label: "Prompt mode",
    kind: "choice",
    options: ["replace", "append"],
    hint: "replace = the body IS the system prompt; append = it is added to the default one.",
  },
  {
    key: "inherit_context",
    label: "Inherit context",
    kind: "boolean",
    hint: "Fork the parent conversation into the agent, so it sees the chat history.",
  },
  {
    key: "run_in_background",
    label: "Background",
    kind: "boolean",
    hint: "Pin this agent to background (on) or foreground (off). Unset follows the backgroundByDefault setting.",
  },
  { key: "isolated", label: "Isolated", kind: "boolean", hint: "Built-in tools only — no extension or MCP tools." },
  { key: "extensions", label: "Extensions", kind: "inherit", hint: "Which extension tools to inherit: all, none, or a named list.", aliases: ["inherit_extensions"] },
  { key: "exclude_extensions", label: "Excluded extensions", kind: "list", hint: "Extension tools to drop even when inherited." },
  { key: "skills", label: "Skills", kind: "inherit", hint: "Skills preloaded into the prompt: all, none, or a named list.", aliases: ["inherit_skills"] },
  {
    key: "allowed_subagents",
    label: "Allowed subagents",
    kind: "subagents",
    hint: "Which agents this one may delegate to: a list, `all`, or unset for none.",
  },
  { key: "disallowed_tools", label: "Disallowed tools", kind: "list", hint: "Tools blocked even when otherwise available." },
  {
    key: "memory",
    label: "Memory",
    kind: "choice",
    options: ["user", "project", "local"],
    hint: "Where durable memory files live. Unset gives the agent none.",
  },
  {
    key: "isolation",
    label: "Worktree",
    kind: "choice",
    options: ["worktree", "off"],
    hint: "Run in an isolated git worktree, or refuse one even when a caller asks. Unset follows the caller.",
  },
  {
    key: "output_transcript",
    label: "Output transcript",
    kind: "boolean",
    hint: "Write this agent's .output transcript. Unset follows the project default.",
  },
  {
    key: "persist_session",
    label: "Persist session",
    kind: "boolean",
    hint: "Keep the pi session on disk so @handle can resume this agent later.",
  },
  { key: "session_dir", label: "Session directory", kind: "text", hint: "Override where this agent's session is stored." },
  {
    key: "messaging_surface",
    label: "Message surface",
    kind: "choice",
    options: ["off", "ui", "context"],
    hint: "How peer messages reach this agent. Unset follows the project default.",
  },
] as const;

const FIELDS_BY_KEY = new Map(AGENT_FIELDS.map(field => [field.key, field]));

export function agentField(key: string): AgentFieldSpec | undefined {
  return FIELDS_BY_KEY.get(key);
}

/** Every frontmatter key the editor owns — a value of `undefined` deletes the key. */
export type AgentFieldValues = Partial<Record<string, AgentFieldValue>>;

function csvList(value: string): string[] {
  return value.split(",").map(entry => entry.trim()).filter(Boolean);
}

function readValue(field: AgentFieldSpec, frontmatter: Record<string, unknown>): AgentFieldValue {
  const raw = frontmatter[field.key];
  switch (field.kind) {
    case "text":
    case "color":
      return typeof raw === "string" ? raw : undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "integer":
      return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
    case "choice":
      return typeof raw === "string" ? raw : undefined;
    case "tools": {
      if (raw === undefined || raw === null) return undefined;
      const value = String(raw).trim();
      if (!value || value === "none") return [];
      return csvList(value);
    }
    case "inherit": {
      if (raw === true) return true;
      if (raw === false) return false;
      if (raw === undefined || raw === null) return undefined;
      const value = String(raw).trim();
      if (!value || value === "none") return false;
      return csvList(value);
    }
    case "list": {
      if (raw === undefined || raw === null) return undefined;
      const value = String(raw).trim();
      if (!value || value === "none") return undefined;
      return csvList(value);
    }
    case "subagents": {
      if (raw === undefined || raw === null) return undefined;
      const value = String(raw).trim();
      if (!value || value === "none") return undefined;
      if (value === "all" || value === "*" || value === "true") return "all";
      const items = csvList(value);
      return items.length > 0 ? items : undefined;
    }
    case "models": {
      // `models:` (list) wins over the singular `model:`; the loader refuses a
      // file that has both, and the writer below keeps that true.
      if (Array.isArray(raw)) {
        const items = raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
        return items.length > 0 ? items : undefined;
      }
      const single = frontmatter.model;
      if (typeof single === "string" && single.length > 0) return [single];
      return typeof raw === "string" && raw.length > 0 ? [raw] : undefined;
    }
  }
}

/** The field values and prompt body an editor starts from. */
export function readAgentFields(content: string): { values: AgentFieldValues; body: string } {
  const { frontmatter, body } = parseAgentFrontmatter<Record<string, unknown>>(content);
  const values: AgentFieldValues = {};
  for (const field of AGENT_FIELDS) values[field.key] = readValue(field, frontmatter);
  return { values, body: body.trim() };
}

/** The node a field's value serializes to, or undefined to drop the key. */
function nodeValue(field: AgentFieldSpec, value: AgentFieldValue): unknown {
  if (value === undefined) return undefined;
  switch (field.kind) {
    case "tools":
    case "list":
    case "inherit": {
      // A bare CSV scalar, not a YAML sequence: these are documented as comma
      // separated, and the loader stringifies whatever it finds.
      if (Array.isArray(value)) return value.length === 0 && field.kind === "tools" ? "none" : value.join(", ");
      return value;
    }
    case "subagents":
      return Array.isArray(value) ? value.join(", ") : value;
    case "models":
      return Array.isArray(value) && value.length > 0 ? value : undefined;
    default:
      return value;
  }
}

/**
 * Rewrite an agent file's frontmatter and body, preserving everything the
 * field table does not own.
 *
 * A file with no frontmatter block gets one. Keys the table does not know
 * survive untouched, which is what makes this safe to point at a file written
 * for a newer version of the extension than the one editing it.
 */
export function applyAgentFields(content: string, values: AgentFieldValues, body: string): string {
  const block = splitFrontmatter(content);
  const eol = block?.eol ?? "\n";
  const doc = block ? parseBlock(block.lines.slice(1, block.closeIdx).join("")) : new Document({});

  for (const [key, value] of Object.entries(values)) {
    const field = agentField(key);
    if (!field) continue;
    const node = nodeValue(field, value);
    if (node === undefined) doc.delete(key);
    else doc.set(key, node);
    for (const alias of field.aliases ?? []) doc.delete(alias);
  }

  const rendered = doc.toString({ lineWidth: 0 });
  const open = block ? block.lines[0] : `---${eol}`;
  const fence = `---${eol}`;
  return `${open}${rendered}${fence}\n${body.trim()}\n`;
}

/**
 * Parse just the inner lines of a frontmatter block, tolerating an empty one.
 *
 * A block that will not parse becomes an empty document, and the fields the
 * caller was given replace it. That is what the loader would do with the file
 * anyway — it skips an unparseable agent — so refusing to write would leave the
 * user with no way out but a text editor.
 */
function parseBlock(inner: string): Document {
  try {
    const doc = parseDocument(inner);
    // Errors are reported on the document, not thrown, and a document with
    // errors cannot be stringified.
    if (doc.errors.length === 0 && doc.contents !== null) return doc;
  } catch {
    // Same outcome as an errored document: start over.
  }
  return new Document({});
}
