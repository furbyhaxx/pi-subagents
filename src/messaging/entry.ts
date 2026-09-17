/**
 * entry.ts — what bus traffic leaves behind in the main session transcript.
 *
 * Messaging cards are *custom session entries*, not custom messages: pi's
 * `appendEntry` persists them and never puts them in the model's context, which
 * is precisely the contract §8.2 asks for. What the model sees is decided by
 * the recipient's `messaging.surface` on the delivery path, and by nothing
 * here — a card is for the human reading over the fleet's shoulder.
 *
 * As with the workflow entry, this file holds the persisted shape only. The
 * card it renders through lives in `ui/messaging-card.ts`, so a session file
 * written today keeps rendering if the drawing changes tomorrow.
 */

import type { MessageKind } from "./types.js";

/** `customType` of the session entry messaging traffic renders through. */
export const MESSAGING_ENTRY_TYPE = "subagents:messaging";

export interface MessageCardData {
  kind: "message";
  from: string;
  /** Absent for a broadcast; `recipients` carries the fan-out instead. */
  to?: string;
  messageKind: MessageKind;
  body: string;
  recipients?: number;
  /** Short id of the sending session, present only when it is not this one. */
  session?: string;
}

export interface BoardCardData {
  kind: "board";
  topic: string;
  /** The key, when the card stands for a single write. */
  key?: string;
  author: string;
  op: "put" | "delete" | "expire";
  revision?: number;
  /** Number of keys a coalesced card stands for, when more than one. */
  keys?: number;
  preview?: string;
  session?: string;
}

/**
 * What a per-minute cap leaves in place of a flood. A count with no detail is
 * the honest rendering: the detail is still in the store, and claiming to have
 * shown traffic that was dropped is worse than saying how much was dropped.
 */
export interface SummaryCardData {
  kind: "summary";
  suppressed: number;
}

export type MessagingCardData = MessageCardData | BoardCardData | SummaryCardData;
