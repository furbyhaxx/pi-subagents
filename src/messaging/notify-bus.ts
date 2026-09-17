/**
 * notify-bus.ts — the deliberately small advisory wakeup seam.
 *
 * Implementations may disappear at any time; callers must retain polling as
 * the correctness path and treat every bump as only a request to look sooner.
 */

export interface NotifyBus {
  bump(mailboxes: readonly string[]): void;
  close(): void;
}

export class NullNotifyBus implements NotifyBus {
  bump(_mailboxes: readonly string[]): void {}
  close(): void {}
}
