/**
 * bash-family.ts — Source-provenance recognition of the background-jobs tool family.
 *
 * A subagent whose tool allowlist contains `bash` gets the extension that owns
 * the parent's `bash` — but only when that extension is the recognized
 * background-jobs family, proven by its tool registry rather than by its name:
 * `bash`, `job_list`, `job_output` and `job_stop` must all be registered by the
 * same non-builtin `sourceInfo.path`. Nothing else is propagated. An unrelated
 * extension that merely overrides `bash` (a sandbox, a wrapper) stays
 * unrecognized and the child keeps the built-in `bash` without job tools.
 *
 * `sourceInfo.path` is the extension entry path pi recorded at registration —
 * the same value `DefaultResourceLoader.additionalExtensionPaths` accepts, which
 * is what makes the family loadable in an `isolated` child: with
 * `noExtensions: true` the loader still loads explicit paths.
 */

import { isAbsolute } from "node:path";

/**
 * The exact tool names the family is recognized by. `bash` alone is not enough:
 * every other extension that overrides the shell would look the same, and
 * propagating it would hand a child an override nobody vouched for.
 */
export const BASH_FAMILY_TOOL_NAMES = ["bash", "job_list", "job_output", "job_stop"] as const;

/** Minimal registry shape read from `pi.getAllTools()` — structural so tests can pass plain objects. */
export interface ToolSource {
  name: string;
  sourceInfo?: { path?: string; source?: string };
}

export interface BashFamily {
  /** Absolute extension entry path that owns the family. */
  path: string;
  /** The recognized family tool names, in {@link BASH_FAMILY_TOOL_NAMES} order. */
  toolNames: string[];
}

/**
 * Absolute, non-builtin `sourceInfo.path` of the tool named `bash`, or undefined
 * when `bash` is a built-in (or absent). This is the un-propagatable case the
 * caller reports: the child gets the built-in shell instead.
 */
export function bashOverridePath(tools: readonly ToolSource[] | undefined): string | undefined {
  const bash = tools?.find((tool) => tool.name === "bash");
  const path = bash?.sourceInfo?.path;
  if (!bash || bash.sourceInfo?.source === "builtin" || !path || !isAbsolute(path)) return undefined;
  return path;
}

/**
 * The background-jobs family, or undefined when the registry does not prove one.
 * Requires all four family tools on the exact same non-builtin absolute path.
 */
export function resolveBashFamily(tools: readonly ToolSource[] | undefined): BashFamily | undefined {
  const path = bashOverridePath(tools);
  if (!path || !tools) return undefined;
  for (const name of BASH_FAMILY_TOOL_NAMES) {
    const info = tools.find((tool) => tool.name === name)?.sourceInfo;
    if (!info || info.source === "builtin" || info.path !== path) return undefined;
  }
  return { path, toolNames: [...BASH_FAMILY_TOOL_NAMES] };
}
