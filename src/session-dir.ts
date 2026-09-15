/**
 * session-dir.ts — The container for child sessions under pi's session root.
 *
 * pi passes `PI_CODING_AGENT_SESSION_DIR` to SessionManager as the session's
 * explicit directory, so every persisted subagent that inherited the default
 * wrote its JSONL beside its spawning session. Children get their own
 * `subagents/` subdirectory instead: one container that keeps child
 * transcripts together and out of the parent's session listing.
 *
 * Only the environment-derived default is resolved here. An explicit
 * frontmatter `session_dir` (agent-runner) and an explicit
 * `sessionArtifactDirectory` (output-file) stay authoritative, and without the
 * environment variable both consumers keep their previous fallbacks.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `<PI_CODING_AGENT_SESSION_DIR>/subagents`, or undefined when the variable is
 * unset or empty.
 *
 * `~` expands the way pi expands it for the parent session directory. A
 * relative value anchors at the process cwd: the result is persisted as an
 * artifact root, and every persisted root has to be absolute.
 */
export function resolveSubagentSessionDir(
  sessionRoot: string | undefined = process.env.PI_CODING_AGENT_SESSION_DIR,
): string | undefined {
  if (!sessionRoot || sessionRoot.trim() === "") return undefined;
  const expanded = sessionRoot === "~"
    ? homedir()
    : sessionRoot.startsWith("~/")
      ? join(homedir(), sessionRoot.slice(2))
      : sessionRoot;
  return resolve(expanded, "subagents");
}
