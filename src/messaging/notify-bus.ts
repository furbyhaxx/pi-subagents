export interface NotifyBus {
  bump(mailboxes: readonly string[]): void;
  close(): void;
}

/** Polling is the correctness path; Phase 5 replaces this advisory no-op. */
export class NullNotifyBus implements NotifyBus {
  bump(_mailboxes: readonly string[]): void {}
  close(): void {}
}
