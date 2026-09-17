/**
 * messaging-card.ts — the transcript card for one piece of bus traffic.
 *
 * ```
 * ▤ blackboard  findings/auth-routes  · explore-2 · rev 3
 *   ⎿  { "file": "src/routes/admin.ts", "missing": ["requireAuth"] }
 *
 * ✉ message  explore-2 → plan  · request
 *   ⎿  admin.ts has no auth middleware — does the plan assume one?
 * ```
 *
 * The layout is pure, like the workflow card's: it returns coloured segments
 * and never touches a theme, so the tests assert plain strings and the theme is
 * applied in one wrapper on top. The segment vocabulary and the clamping are
 * the workflow card's — two card layouts with two ideas of what a line is would
 * drift, and this one has no reason to differ.
 *
 * Peer text is rendered dim and always behind the sender's name: quoted data in
 * a human's transcript, never something the transcript speaks in its own voice
 * (§9).
 */

import { Text } from "@earendil-works/pi-tui";
import type { MessagingCardData } from "../messaging/entry.js";
import type { Theme } from "./agent-widget.js";
import { clampLine, styleWorkflowCardLines, type WorkflowCardLine } from "./workflow-card.js";

const DEFAULT_WIDTH = 80;

/** Board glyph, message glyph, and the result-line prefix the Agent tool uses. */
const GLYPHS = { board: "▤", message: "✉", log: "⎿" };

export function layoutMessagingCard(data: MessagingCardData, width = DEFAULT_WIDTH): WorkflowCardLine[] {
  if (data.kind === "summary") {
    const plural = data.suppressed === 1 ? "event" : "events";
    return [[{ text: `  … ${data.suppressed} more messaging ${plural} this minute`, color: "dim" }]];
  }

  const head: WorkflowCardLine = [];
  let body: string | undefined;
  if (data.kind === "message") {
    const route = data.to
      ? `${data.from} → ${data.to}`
      : `${data.from} → all${data.recipients ? ` (${data.recipients})` : ""}`;
    head.push(
      { text: `${GLYPHS.message} `, color: "accent" },
      { text: "message", color: "dim" },
      { text: `  ${route}`, bold: true },
      { text: "  · ", color: "dim" },
      { text: data.messageKind, color: "dim" },
    );
    body = data.body;
  } else {
    const subject = data.key ? `${data.topic}/${data.key}` : data.topic;
    head.push(
      { text: `${GLYPHS.board} `, color: "accent" },
      { text: "blackboard", color: "dim" },
      { text: `  ${subject}`, bold: true },
      { text: "  · ", color: "dim" },
      { text: data.author, color: "dim" },
    );
    if (data.op === "expire") head.push({ text: " · ", color: "dim" }, { text: "expired", color: "warning" });
    else if (data.op === "delete") head.push({ text: " · ", color: "dim" }, { text: "deleted", color: "warning" });
    else if (data.keys !== undefined) head.push({ text: " · ", color: "dim" }, { text: `${data.keys} keys`, color: "dim" });
    else if (data.revision !== undefined) head.push({ text: " · ", color: "dim" }, { text: `rev ${data.revision}`, color: "dim" });
    body = data.preview;
  }
  // A foreign session is the one attribution a reader cannot infer from the
  // handle, and cross-session traffic has to be visibly cross-session.
  if (data.session) head.push({ text: " · ", color: "dim" }, { text: `session ${data.session}`, color: "muted" });

  const lines = [clampLine(head, width)];
  if (body) lines.push(clampLine([{ text: `  ${GLYPHS.log}  ${body}`, color: "dim" }], width));
  return lines;
}

/** The card as plain text — what the layout tests assert against. */
export function plainMessagingCardLines(lines: readonly WorkflowCardLine[]): string[] {
  return lines.map(line => line.map(segment => segment.text).join(""));
}

export function renderMessagingCard(
  data: MessagingCardData | undefined,
  theme: Theme,
  width?: number,
): Text | undefined {
  if (!data) return undefined;
  return new Text(styleWorkflowCardLines(layoutMessagingCard(data, width), theme).join("\n"), 0, 0);
}
