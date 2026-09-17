/**
 * notify-bus.ts — the deliberately small advisory wakeup seam.
 *
 * Implementations may disappear at any time; callers must retain polling as
 * the correctness path and treat every bump as only a request to look sooner.
 */

import type { MessagingTransportMode } from "./types.js";

export interface NotifyBus {
  readonly mode: MessagingTransportMode;
  bump(mailboxes: readonly string[]): void;
  close(): void;
}

export class NullNotifyBus implements NotifyBus {
  readonly mode = "off" as const;
  bump(_mailboxes: readonly string[]): void {}
  close(): void {}
}
