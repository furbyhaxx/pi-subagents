/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { CanonicalModelId } from "./types.js";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ParsedCanonicalModelId {
  input: CanonicalModelId;
  provider: string;
  modelId: string;
  thinking?: ModelThinkingLevel;
}

export interface ResolvedModelCandidate {
  input: string;
  model: Model<Api>;
  thinking?: ModelThinkingLevel;
}

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/** Validate and split a canonical provider/model[:thinking] identifier. */
export function parseCanonicalModelId(input: string): ParsedCanonicalModelId {
  if (input.trim() !== input || /\s/.test(input)) {
    throw new Error(`Invalid canonical model ID "${input}": whitespace is not allowed.`);
  }
  const slash = input.indexOf("/");
  if (slash <= 0 || slash === input.length - 1) {
    throw new Error(`Invalid canonical model ID "${input}": expected provider/model.`);
  }
  const provider = input.slice(0, slash);
  const rawModelId = input.slice(slash + 1);
  const colon = rawModelId.lastIndexOf(":");
  const suffix = colon === -1 ? undefined : rawModelId.slice(colon + 1);
  const thinking = MODEL_THINKING_LEVELS.find(level => level === suffix);
  return {
    input,
    provider,
    modelId: thinking ? rawModelId.slice(0, colon) : rawModelId,
    ...(thinking ? { thinking } : {}),
  };
}

/**
 * Resolve a frontmatter candidate exactly. A literal colon-bearing model ID wins
 * over interpreting its tail as a thinking suffix.
 */
export function resolveCanonicalModel(
  input: string,
  registry: ModelRegistry,
): ResolvedModelCandidate | string {
  let parsed: ParsedCanonicalModelId;
  try {
    parsed = parseCanonicalModelId(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  const slash = input.indexOf("/");
  const literalId = input.slice(slash + 1);
  const literal = registry.find(parsed.provider, literalId) as ModelEntry | undefined;
  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const availableKeys = new Set(available.map(model => `${model.provider}/${model.id}`));
  if (literal) {
    return availableKeys.has(`${literal.provider}/${literal.id}`)
      ? { input, model: literal as Model<Api> }
      : `Model unavailable: "${input}".`;
  }

  const resolved = registry.find(parsed.provider, parsed.modelId) as ModelEntry | undefined;
  if (!resolved) return `Model not found: "${input}".`;
  if (!availableKeys.has(`${resolved.provider}/${resolved.id}`)) {
    return `Model unavailable: "${input}".`;
  }
  return { input, model: resolved as Model<Api>, ...(parsed.thinking ? { thinking: parsed.thinking } : {}) };
}

export interface ModelCandidateResolution {
  candidates: ResolvedModelCandidate[];
  errors: string[];
}

/** Resolve one caller override fuzzily, or an ordered configured list exactly. */
export function resolveModelCandidates(
  inputs: readonly string[],
  registry: ModelRegistry,
  callerSupplied: boolean,
): ModelCandidateResolution {
  const candidates: ResolvedModelCandidate[] = [];
  const errors: string[] = [];
  for (const input of inputs) {
    const resolved = callerSupplied
      ? resolveModelCandidate(input, registry)
      : resolveCanonicalModel(input, registry);
    if (typeof resolved === "string") errors.push(resolved);
    else candidates.push(resolved);
  }
  return { candidates, errors };
}

/**
 * Both display forms of a model. The short one goes on tight rows (the widget,
 * the Agent tool result), the canonical one where there is room to disambiguate
 * two providers serving a similarly-named model (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run
 * and `agent-manager.ts` relabels it from the live session afterwards — the two
 * must agree or the label would visibly change the moment the session starts.
 */
export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

/** Resolve a caller input, retaining an optional explicit thinking suffix. */
export function resolveModelCandidate(
  input: string,
  registry: ModelRegistry,
): ResolvedModelCandidate | string {
  if (input.includes("/")) {
    const slash = input.indexOf("/");
    const literalExists = slash > 0 && registry.find(input.slice(0, slash), input.slice(slash + 1)) !== undefined;
    const canonical = resolveCanonicalModel(input, registry);
    if (typeof canonical !== "string" || literalExists) return canonical;
    let parsed: ParsedCanonicalModelId;
    try {
      parsed = parseCanonicalModelId(input);
    } catch {
      const resolved = resolveModel(input, registry);
      return typeof resolved === "string" ? resolved : { input, model: resolved as Model<Api> };
    }
    if (parsed.thinking) {
      const resolved = resolveModel(`${parsed.provider}/${parsed.modelId}`, registry);
      return typeof resolved === "string"
        ? resolved
        : { input, model: resolved as Model<Api>, thinking: parsed.thinking };
    }
  }
  const resolved = resolveModel(input, registry);
  return typeof resolved === "string" ? resolved : { input, model: resolved as Model<Api> };
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): any | string {
  // Available models (those with auth configured)
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const availableSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match against available models. Normalize separators so cosmetic
  // punctuation differences still match — e.g. "claude-haiku-4.5" and
  // "claude-haiku-4-5" (dot vs dash in the version) resolve to the same model.
  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  // Score each model: prefer exact id match > id contains > name contains > provider+id contains
  let bestMatch: ModelEntry | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      // A trailing date-stamp token (e.g. "20251001") is optional, so a
      // date-pinned config like "claude-haiku-4-5-20251001" still matches an
      // undated registry id like "claude-haiku-4-5".
      query
        .split(/[\s\-/]+/)
        .every(part => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
    ) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. Provider fallback: a "provider/modelId" query that didn't match under the
  // named provider (exact or fuzzy above) retries against all providers. The
  // named provider is preferred when present; this only kicks in when it isn't,
  // so the same model from another provider beats falling back to "inherit".
  if (slashIdx !== -1) {
    const bare = resolveModel(input.slice(slashIdx + 1), registry);
    if (typeof bare !== "string") return bare;
  }

  // 4. No match — list available models
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}
