/**
 * cards.ts — turns bus activity into the handful of transcript cards a human
 * can actually read.
 *
 * Three rules, all of them about not becoming noise (§8.2):
 *
 * - **No echo.** Traffic the main session sent or received is suppressed: it
 *   already appears there as its own tool call or its own incoming block, and
 *   a card beside it is the same event twice.
 * - **Coalesced.** Board writes by one author to one topic inside a short
 *   window collapse into one card with a key count. Ten `put`s while a subagent
 *   records its findings are one event to a reader, not ten.
 * - **Capped.** Past a cards-per-minute budget the feed stops drawing and
 *   counts instead, then emits a single summary row for the minute. A
 *   transcript that scrolls a hundred cards has told the human nothing.
 *
 * The feed owns a timer because coalescing is inherently "wait and see": call
 * {@link MessagingCardFeed.close} to flush what is held and stop it.
 */

import type { BoardCardData, MessagingCardData } from "./entry.js";
import type { MessagingActivity } from "./types.js";

/** How long board writes to one topic wait to be joined by their siblings. */
const COALESCE_MS = 1_500;
/** Cards drawn per minute before the feed switches to counting. */
const CARDS_PER_MINUTE = 20;
const WINDOW_MS = 60_000;
/** Body and value previews are one line in the collapsed card. */
const PREVIEW_MAX = 160;

export interface MessagingCardFeedOptions {
  /** The main session's own peer id — the endpoint whose echo is suppressed. */
  mainAgentId: string;
  /** Session traffic is attributed against, to label anything foreign. */
  mainSessionId: string;
  append: (data: MessagingCardData) => void;
  coalesceMs?: number;
  cardsPerMinute?: number;
  clock?: () => number;
}

interface PendingBoard {
  topic: string;
  author: string;
  session?: string;
  op: "put" | "delete" | "expire";
  keys: Set<string>;
  revision?: number;
  preview?: string;
}

function preview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_MAX ? `${oneLine.slice(0, PREVIEW_MAX)}…` : oneLine;
}

export class MessagingCardFeed {
  private readonly mainAgentId: string;
  private readonly mainSessionId: string;
  private readonly append: (data: MessagingCardData) => void;
  private readonly coalesceMs: number;
  private readonly cardsPerMinute: number;
  private readonly clock: () => number;
  private readonly pending = new Map<string, PendingBoard>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private windowStart = 0;
  private drawn = 0;
  private suppressed = 0;

  constructor(options: MessagingCardFeedOptions) {
    this.mainAgentId = options.mainAgentId;
    this.mainSessionId = options.mainSessionId;
    this.append = options.append;
    this.coalesceMs = options.coalesceMs ?? COALESCE_MS;
    this.cardsPerMinute = options.cardsPerMinute ?? CARDS_PER_MINUTE;
    this.clock = options.clock ?? Date.now;
  }

  record(activity: MessagingActivity): void {
    if (activity.type === "message") {
      if (activity.fromAgent === this.mainAgentId || activity.toAgent === this.mainAgentId) return;
      this.draw({
        kind: "message",
        from: activity.fromLabel,
        to: activity.toLabel,
        messageKind: activity.kind,
        body: preview(activity.body) ?? "",
        recipients: activity.recipients,
        session: this.foreignSession(activity.fromSession),
      });
      return;
    }

    if (activity.authorAgent === this.mainAgentId) return;
    const key = `${activity.topic}\u0000${activity.author}\u0000${activity.authorAgent ?? ""}\u0000${activity.authorSession ?? ""}\u0000${activity.op}`;
    const held = this.pending.get(key);
    if (held) {
      held.keys.add(activity.key);
      held.revision = activity.revision;
      held.preview = preview(activity.value);
    } else {
      this.pending.set(key, {
        topic: activity.topic,
        author: activity.author,
        session: this.foreignSession(activity.authorSession),
        op: activity.op,
        keys: new Set([activity.key]),
        revision: activity.revision,
        preview: preview(activity.value),
      });
    }
    this.arm();
  }

  /** Draw everything held, and close an expired cap window. */
  flush(): void {
    for (const held of this.pending.values()) this.draw(boardCard(held));
    this.pending.clear();
    this.rollWindow();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
  }

  private foreignSession(sessionId: string | null): string | undefined {
    return sessionId === null || sessionId === this.mainSessionId ? undefined : sessionId.slice(0, 6);
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
      // A suppressed minute still owes the reader its summary, so keep a timer
      // alive until the window that dropped the cards has actually closed.
      if (this.suppressed > 0) this.arm();
    }, this.coalesceMs);
    this.timer.unref?.();
  }

  private rollWindow(): void {
    if (this.windowStart === 0 || this.clock() - this.windowStart < WINDOW_MS) return;
    if (this.suppressed > 0) this.append({ kind: "summary", suppressed: this.suppressed });
    this.windowStart = 0;
    this.drawn = 0;
    this.suppressed = 0;
  }

  private draw(data: MessagingCardData): void {
    this.rollWindow();
    if (this.windowStart === 0) this.windowStart = this.clock();
    if (this.drawn >= this.cardsPerMinute) {
      this.suppressed++;
      this.arm();
      return;
    }
    this.drawn++;
    this.append(data);
  }
}

function boardCard(held: PendingBoard): BoardCardData {
  const keys = [...held.keys];
  return {
    kind: "board",
    topic: held.topic,
    author: held.author,
    op: held.op,
    ...(keys.length === 1 ? { key: keys[0], revision: held.revision, preview: held.preview } : { keys: keys.length }),
    ...(held.session !== undefined ? { session: held.session } : {}),
  };
}
