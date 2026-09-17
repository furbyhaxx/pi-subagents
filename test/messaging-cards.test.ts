/**
 * messaging-cards.test.ts — the transcript surface for bus traffic.
 *
 * Two things are under test and they fail differently: the feed decides *what
 * is worth a card* (echo suppression, coalescing, the per-minute cap), and the
 * layout decides how one reads. A feed bug floods a human's transcript; a
 * layout bug merely looks wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagingCardFeed } from "../src/messaging/cards.js";
import type { MessagingCardData } from "../src/messaging/entry.js";
import type { BoardActivity, MessageActivity } from "../src/messaging/types.js";
import { layoutMessagingCard, plainMessagingCardLines } from "../src/ui/messaging-card.js";

const MAIN = "main:session-a";

function message(overrides: Partial<MessageActivity> = {}): MessageActivity {
  return {
    type: "message",
    fromAgent: "agent-1",
    fromLabel: "explore-2",
    fromSession: "session-a",
    toAgent: "agent-2",
    toLabel: "plan",
    kind: "request",
    body: "admin.ts has no auth middleware",
    at: 1_000,
    ...overrides,
  };
}

function board(overrides: Partial<BoardActivity> = {}): BoardActivity {
  return {
    type: "board",
    op: "put",
    topic: "findings",
    key: "auth-routes",
    author: "explore-2",
    authorAgent: "agent-1",
    authorSession: "session-a",
    revision: 3,
    value: { file: "src/routes/admin.ts" },
    at: 1_000,
    ...overrides,
  };
}

describe("MessagingCardFeed", () => {
  let cards: MessagingCardData[];
  let now: number;
  let feed: MessagingCardFeed;

  beforeEach(() => {
    vi.useFakeTimers();
    cards = [];
    now = 10_000;
    feed = new MessagingCardFeed({
      mainAgentId: MAIN,
      mainSessionId: "session-a",
      append: data => cards.push(data),
      clock: () => now,
    });
  });

  afterEach(() => {
    feed.close();
    vi.useRealTimers();
  });

  it("draws peer-to-peer traffic the main session is not an endpoint of", () => {
    feed.record(message());

    expect(cards).toEqual([{
      kind: "message",
      from: "explore-2",
      to: "plan",
      messageKind: "request",
      body: "admin.ts has no auth middleware",
    }]);
  });

  it("suppresses the main session's own echo at either end", () => {
    // It already appears there as its own tool call or its own incoming block;
    // a card beside it is the same event rendered twice.
    feed.record(message({ fromAgent: MAIN }));
    feed.record(message({ toAgent: MAIN }));
    feed.record(board({ authorAgent: MAIN }));
    vi.advanceTimersByTime(5_000);

    expect(cards).toEqual([]);
  });

  it("collapses a burst of writes to one topic into a single card with a key count", () => {
    for (const key of ["a", "b", "c", "d"]) feed.record(board({ key }));
    expect(cards).toEqual([]);

    vi.advanceTimersByTime(1_500);

    expect(cards).toEqual([{ kind: "board", topic: "findings", author: "explore-2", op: "put", keys: 4 }]);
  });

  it("keeps a lone write's key, revision and preview", () => {
    feed.record(board());
    vi.advanceTimersByTime(1_500);

    expect(cards).toEqual([{
      kind: "board",
      topic: "findings",
      key: "auth-routes",
      author: "explore-2",
      op: "put",
      revision: 3,
      preview: '{"file":"src/routes/admin.ts"}',
    }]);
  });

  it("keeps separate authors and topics apart", () => {
    feed.record(board({ key: "a" }));
    feed.record(board({ key: "b", author: "plan", authorAgent: "agent-2" }));
    feed.record(board({ key: "c", topic: "contracts" }));
    vi.advanceTimersByTime(1_500);

    expect(cards).toHaveLength(3);
  });

  it("labels traffic from another session and leaves local traffic unlabelled", () => {
    feed.record(message({ fromSession: "9f3a1c77-beef" }));
    feed.record(board({ authorSession: "9f3a1c77-beef" }));
    vi.advanceTimersByTime(1_500);

    expect(cards).toMatchObject([{ session: "9f3a1c" }, { session: "9f3a1c" }]);
  });

  it("stops drawing past the per-minute budget and reports what it dropped", () => {
    for (let index = 0; index < 25; index++) feed.record(message({ body: `m${index}` }));

    expect(cards).toHaveLength(20);

    // The summary belongs to the minute that dropped them, so it lands when
    // that window closes rather than at some arbitrary later event.
    now += 60_000;
    vi.advanceTimersByTime(1_500);

    expect(cards[20]).toEqual({ kind: "summary", suppressed: 5 });
    feed.record(message({ body: "next minute" }));
    expect(cards[21]).toMatchObject({ kind: "message", body: "next minute" });
  });

  it("draws what it is still holding when the session ends", () => {
    feed.record(board());
    feed.close();

    expect(cards).toHaveLength(1);
  });
});

describe("messaging card layout", () => {
  it("renders a message as sender, recipient, kind and quoted body", () => {
    const lines = plainMessagingCardLines(layoutMessagingCard({
      kind: "message",
      from: "explore-2",
      to: "plan",
      messageKind: "request",
      body: "admin.ts has no auth middleware",
    }));

    expect(lines).toEqual([
      "✉ message  explore-2 → plan  · request",
      "  ⎿  admin.ts has no auth middleware",
    ]);
  });

  it("names the fan-out of a broadcast, which has no single recipient", () => {
    const [head] = plainMessagingCardLines(layoutMessagingCard({
      kind: "message",
      from: "explore-2",
      messageKind: "event",
      body: "routes mapped",
      recipients: 3,
    }));

    expect(head).toBe("✉ message  explore-2 → all (3)  · event");
  });

  it("renders a board write, a coalesced burst, a delete and a foreign session", () => {
    const write = plainMessagingCardLines(layoutMessagingCard({
      kind: "board",
      topic: "findings",
      key: "auth-routes",
      author: "explore-2",
      op: "put",
      revision: 3,
      preview: '{"missing":["requireAuth"]}',
    }));
    const [burst] = plainMessagingCardLines(layoutMessagingCard({
      kind: "board",
      topic: "findings",
      author: "explore-2",
      op: "put",
      keys: 4,
    }));
    const [deleted] = plainMessagingCardLines(layoutMessagingCard({
      kind: "board",
      topic: "findings",
      key: "stale",
      author: "plan",
      op: "delete",
      session: "9f3a1c",
    }));

    expect(write).toEqual([
      "▤ blackboard  findings/auth-routes  · explore-2 · rev 3",
      '  ⎿  {"missing":["requireAuth"]}',
    ]);
    expect(burst).toBe("▤ blackboard  findings  · explore-2 · 4 keys");
    expect(deleted).toBe("▤ blackboard  findings/stale  · plan · deleted · session 9f3a1c");
  });

  it("says how much a capped minute dropped instead of pretending it drew it", () => {
    const [one] = plainMessagingCardLines(layoutMessagingCard({ kind: "summary", suppressed: 1 }));
    const [many] = plainMessagingCardLines(layoutMessagingCard({ kind: "summary", suppressed: 37 }));

    expect(one).toBe("  … 1 more messaging event this minute");
    expect(many).toBe("  … 37 more messaging events this minute");
  });

  it("clamps a long line to the terminal width", () => {
    const [head] = plainMessagingCardLines(layoutMessagingCard({
      kind: "message",
      from: "explore-2",
      to: "plan",
      messageKind: "request",
      body: "x",
    }, 20));

    expect(head!.length).toBeLessThanOrEqual(20);
  });
});
