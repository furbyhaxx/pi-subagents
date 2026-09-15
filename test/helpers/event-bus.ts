/**
 * event-bus.ts — a minimal in-process `pi.events` stand-in for tests.
 *
 * The real bus is a synchronous emit to every current subscriber; this
 * reproduces that shape, records the request side of each round trip, and
 * exposes listener counts so tests can prove request-scoped reply
 * subscriptions do not outlive their request.
 */
export interface TestEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
  /** Every emit in order — `data` is the caller's payload (usually `{ requestId, … }`). */
  emitted: { channel: string; data: Record<string, unknown> }[];
  listenerCount(channel: string): number;
}

export function createTestEventBus(): TestEventBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted: { channel: string; data: Record<string, unknown> }[] = [];
  return {
    on(channel, handler) {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return () => {
        const current = handlers.get(channel);
        current?.delete(handler);
        if (current && current.size === 0) handlers.delete(channel);
      };
    },
    emit(channel, data) {
      emitted.push({ channel, data: (data ?? {}) as Record<string, unknown> });
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
    },
    emitted,
    listenerCount(channel) {
      return handlers.get(channel)?.size ?? 0;
    },
  };
}
