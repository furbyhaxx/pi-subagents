import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BridgeDelivery,
  DeliveryBridge,
  RecipientDeliveryInfo,
} from "../src/messaging/delivery-bridge.js";
import { NullNotifyBus } from "../src/messaging/notify-bus.js";
import { AgentMessagingService } from "../src/messaging/service.js";
import { SqliteStore } from "../src/messaging/store.js";
import { createAgentMessageTool } from "../src/messaging/tool.js";
import type { AgentRegistration, AgentRow, MessagingSurface, PeerAccess } from "../src/messaging/types.js";

class FakeBridge implements DeliveryBridge {
  access = new Map<string, PeerAccess>();
  nested = new Set<string>();
  info = new Map<string, RecipientDeliveryInfo>();
  deliveries: Array<{ agentId: string; content: string; wake: boolean }> = [];

  peerAccess(agent: AgentRow): PeerAccess {
    return this.access.get(agent.agentId) ?? "local";
  }

  recipientInfo(agent: AgentRow): RecipientDeliveryInfo {
    return this.info.get(agent.agentId) ?? {
      ownership: "local",
      state: "running",
      surface: "ui",
      kind: agent.kind,
      sessionId: agent.sessionId,
    };
  }

  isNestedAgentId(agentId: string): boolean {
    return this.nested.has(agentId);
  }

  async deliver(agent: AgentRow, content: string, wake: boolean): Promise<BridgeDelivery> {
    this.deliveries.push({ agentId: agent.agentId, content, wake });
    return { delivered: true, woken: wake };
  }
}

describe("AgentMessagingService", () => {
  let directory: string;
  let store: SqliteStore;
  let bridge: FakeBridge;
  let service: AgentMessagingService;
  let now: number;

  const caller = { agentId: "caller", sessionId: "session-a" };

  function registration(
    agentId: string,
    sessionId: string,
    handle: string,
    overrides: Partial<AgentRegistration> = {},
  ): AgentRegistration {
    return {
      agentId,
      sessionId,
      handle,
      kind: "sub",
      type: "Explore",
      status: "running",
      pid: process.pid,
      ...overrides,
    };
  }

  function setInfo(agentId: string, surface: MessagingSurface, state: RecipientDeliveryInfo["state"] = "running") {
    const peer = store.listPeers().find(item => item.agentId === agentId)!;
    bridge.info.set(agentId, { ownership: "local", state, surface, kind: peer.kind, sessionId: peer.sessionId });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "messaging-service-test-"));
    now = 1_000;
    store = new SqliteStore({
      filePath: join(directory, "messaging.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: () => now,
    });
    bridge = new FakeBridge();
    service = new AgentMessagingService({ store, bridge, operatorSessionId: "session-a", clock: () => now });
    service.registerAgent(registration("caller", "session-a", "caller"));
  });

  afterEach(() => {
    service.close();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it("exposes from only as a wait filter, never as caller-controlled authorship", () => {
    const tool = createAgentMessageTool(() => service, () => caller);
    const properties = tool.parameters.properties as Record<string, unknown>;

    expect(properties).toHaveProperty("from");
    expect(properties).not.toHaveProperty("author");
  });

  it("resolves exact ids, own-session handles, and refuses ambiguous cross-session handles", () => {
    service.registerAgent(registration("own", "alpha-111", "explore"));
    service.registerAgent(registration("foreign", "beta-222", "explore"));

    expect(service.resolveTarget(caller, "foreign")).toMatchObject({ ok: true, agent: { agentId: "foreign" } });
    expect(service.resolveTarget({ ...caller, sessionId: "alpha-111" }, "explore")).toMatchObject({ ok: true, agent: { agentId: "own" } });

    const otherCaller = { agentId: "third", sessionId: "gamma-333" };
    expect(service.resolveTarget(otherCaller, "explore")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["explore@alpha-", "explore@beta-2"],
    });
  });

  it("lists minimal unique session prefixes when six characters collide", () => {
    service.registerAgent(registration("one", "abcdef1-session", "explore"));
    service.registerAgent(registration("two", "abcdef2-session", "explore"));

    expect(service.resolveTarget(caller, "explore")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["explore@abcdef1", "explore@abcdef2"],
    });
    expect(service.resolveTarget(caller, "explore@abcdef2")).toMatchObject({
      ok: true,
      agent: { agentId: "two" },
    });
  });

  it("refuses a manager-owned nested child before roster lookup", () => {
    bridge.nested.add("nested-id");
    expect(service.resolveTarget(caller, "nested-id")).toEqual({ ok: false, reason: "nested-child" });
  });

  it("uses the recipient surface for notices, bodies, and off delivery", async () => {
    service.registerAgent(registration("notice", "session-a", "notice"));
    service.registerAgent(registration("body", "session-a", "body"));
    service.registerAgent(registration("off", "session-a", "off"));
    setInfo("notice", "ui");
    setInfo("body", "context");
    setInfo("off", "off");

    const ui = await service.send(caller, { to: "notice", message: "UI_SECRET" });
    const context = await service.send(caller, { to: "body", message: "BODY_TEXT" });
    const off = await service.send(caller, { to: "off", message: "OFF_TEXT" });

    expect(ui.receipt).toMatchObject({ status: "injected", surface: "notice" });
    expect(bridge.deliveries[0]?.content).not.toContain("UI_SECRET");
    expect(bridge.deliveries[0]?.content).toContain('op:"inbox"');
    expect(context.receipt).toMatchObject({ status: "injected", surface: "body" });
    expect(bridge.deliveries[1]?.content).toContain("untrusted peer-authored content");
    expect(bridge.deliveries[1]?.content).toContain("BODY_TEXT");
    expect(off.receipt).toMatchObject({ status: "queued", reason: "surface-off" });
    expect(bridge.deliveries).toHaveLength(2);
  });

  it("keeps a literal closing sentinel inside a nonce-bound peer block", async () => {
    service.registerAgent(registration("body", "session-a", "body"));
    setInfo("body", "context");

    await service.send(caller, { to: "body", message: "before </peer_message> after" });

    const content = bridge.deliveries[0]!.content;
    const nonce = /<peer_message:([a-f0-9-]+) /.exec(content)?.[1];
    expect(nonce).toBeTruthy();
    expect(content).toContain("before </peer_message> after");
    expect(content.endsWith(`</peer_message:${nonce}>`)).toBe(true);
  });

  it("defaults tool waits, caps them, and filters by sender", async () => {
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "wait.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: Date.now,
    });
    bridge = new FakeBridge();
    service = new AgentMessagingService({ store, bridge, operatorSessionId: "session-a", maxWaitMs: 25 });
    service.registerAgent(registration("caller", "session-a", "caller"));
    service.registerAgent(registration("wanted", "session-a", "wanted"));
    service.registerAgent(registration("other", "session-a", "other"));
    store.enqueue({ id: "other-message", fromAgent: "other", toAgent: "caller", kind: "message", body: "other" });
    store.enqueue({ id: "wanted-message", fromAgent: "wanted", toAgent: "caller", kind: "message", body: "wanted" });

    expect((await service.wait(caller, 0, "wanted"))?.id).toBe("wanted-message");
    const wait = vi.spyOn(service, "wait").mockResolvedValue(undefined);
    const tool = createAgentMessageTool(() => service, () => caller);
    await tool.execute("wait-call", { op: "wait" }, undefined, undefined, {} as ExtensionContext);
    expect(wait).toHaveBeenCalledWith(caller, 30_000, undefined, undefined);
    wait.mockRestore();

    const started = Date.now();
    await service.wait(caller, 10_000, "wanted");
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("defers UI delivery while wait consumes the message without a stale notice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "active-wait.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: Date.now,
    });
    bridge = new FakeBridge();
    service = new AgentMessagingService({
      store,
      bridge,
      operatorSessionId: "session-a",
      clock: Date.now,
      random: () => 0,
    });
    service.registerAgent(registration("caller", "session-a", "caller"));
    service.registerAgent(registration("sender", "session-a", "sender"));

    const waiting = service.wait(caller, 1_000);
    const sent = await service.send(
      { agentId: "sender", sessionId: "session-a" },
      { to: "caller", message: "live" },
    );
    await service.pollOwnedMailboxes();

    expect(sent.receipt).toMatchObject({ status: "queued", reason: "active-wait" });
    expect(bridge.deliveries).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(225);
    const received = await waiting;
    expect(received).toMatchObject({ fromAgent: "sender", toAgent: "caller", body: "live" });
    expect(service.inbox(caller)).toEqual([]);

    await service.pollOwnedMailboxes();
    expect(bridge.deliveries).toHaveLength(0);
  });

  it("defers a whole UI batch during a filtered wait and delivers unmatched mail afterward", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "filtered-active-wait.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: Date.now,
    });
    bridge = new FakeBridge();
    service = new AgentMessagingService({
      store,
      bridge,
      operatorSessionId: "session-a",
      clock: Date.now,
      random: () => 0,
    });
    service.registerAgent(registration("caller", "session-a", "caller"));
    service.registerAgent(registration("wanted", "session-a", "wanted"));
    service.registerAgent(registration("other", "session-a", "other"));

    const waiting = service.wait(caller, 1_000, "wanted");
    const other = await service.send(
      { agentId: "other", sessionId: "session-a" },
      { to: "caller", message: "other body" },
    );
    const wanted = await service.send(
      { agentId: "wanted", sessionId: "session-a" },
      { to: "caller", message: "wanted body" },
    );

    expect(other.receipt).toMatchObject({ status: "queued", reason: "active-wait" });
    expect(wanted.receipt).toMatchObject({ status: "queued", reason: "active-wait" });
    expect(bridge.deliveries).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(225);
    expect(await waiting).toMatchObject({ fromAgent: "wanted", body: "wanted body" });
    await service.pollOwnedMailboxes();

    expect(bridge.deliveries).toHaveLength(1);
    expect(bridge.deliveries[0]?.content).toContain("other sent message; 1 unread");
    expect(service.inbox(caller).map(message => message.body)).toEqual(["other body"]);
  });

  it("reference-counts overlapping waits and cleans up on abort and timeout without affecting context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "active-wait-cleanup.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: Date.now,
    });
    bridge = new FakeBridge();
    service = new AgentMessagingService({
      store,
      bridge,
      operatorSessionId: "session-a",
      clock: Date.now,
      random: () => 0,
    });
    service.registerAgent(registration("caller", "session-a", "caller"));
    service.registerAgent(registration("sender", "session-a", "sender"));
    service.registerAgent(registration("context", "session-a", "context"));
    setInfo("context", "context");

    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = service.wait(caller, 1_000, undefined, firstAbort.signal);
    const second = service.wait(caller, 1_000, undefined, secondAbort.signal);
    firstAbort.abort();
    await expect(first).rejects.toThrow();

    const stillWaiting = await service.send(
      { agentId: "sender", sessionId: "session-a" },
      { to: "caller", message: "queued" },
    );
    expect(stillWaiting.receipt).toMatchObject({ status: "queued", reason: "active-wait" });

    const contextAbort = new AbortController();
    const contextWaiting = service.wait({ agentId: "context", sessionId: "session-a" }, 1_000, undefined, contextAbort.signal);
    const context = await service.send(caller, { to: "context", message: "body" });
    expect(context.receipt).toMatchObject({ status: "injected", surface: "body" });
    contextAbort.abort();
    await expect(contextWaiting).rejects.toThrow();

    secondAbort.abort();
    await expect(second).rejects.toThrow();
    await service.pollOwnedMailboxes();
    expect(bridge.deliveries).toHaveLength(2);
    expect(bridge.deliveries[1]?.content).toContain("1 unread");
    service.inbox(caller);

    const timedOut = service.wait(caller, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await timedOut).toBeUndefined();
    const afterTimeout = await service.send(
      { agentId: "sender", sessionId: "session-a" },
      { to: "caller", message: "delivered" },
    );
    expect(afterTimeout.receipt).toMatchObject({ status: "injected", surface: "notice" });
  });

  it("jitters each wait and watch delay, clamps deadlines, and never sleeps for zero", async () => {
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "jitter.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: () => now,
    });
    const random = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0.999);
    service = new AgentMessagingService({ store, bridge, operatorSessionId: "session-a", clock: () => now, random });
    service.registerAgent(registration("caller", "session-a", "caller"));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    expect(await service.wait(caller, 0)).toBeUndefined();
    expect(random).not.toHaveBeenCalled();

    const waitAbort = new AbortController();
    const waiting = service.wait(caller, 1_000, undefined, waitAbort.signal);
    expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(225);
    waitAbort.abort();
    await expect(waiting).rejects.toThrow();

    const watchAbort = new AbortController();
    const watching = service.boardWatch(0, 1_000, undefined, watchAbort.signal);
    expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBeCloseTo(274.95);
    watchAbort.abort();
    await expect(watching).rejects.toThrow();

    const deadlineAbort = new AbortController();
    const deadlineWait = service.wait(caller, 200, undefined, deadlineAbort.signal);
    expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(200);
    deadlineAbort.abort();
    await expect(deadlineWait).rejects.toThrow();
    expect(random).toHaveBeenCalledTimes(3);
  });

  it("self-schedules independently jittered idle polls and starts once", async () => {
    vi.useFakeTimers();
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "idle-jitter.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: Date.now,
    });
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    service = new AgentMessagingService({ store, bridge, operatorSessionId: "session-a", random });
    const poll = vi.spyOn(service, "pollOwnedMailboxes").mockResolvedValue();

    service.start();
    service.start();
    expect(random).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_499);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_498);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("does not start another idle chain while its poll is still running", async () => {
    vi.useFakeTimers();
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "idle-running.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: Date.now,
    });
    service = new AgentMessagingService({ store, bridge, operatorSessionId: "session-a", random: () => 0 });
    let releasePoll: (() => void) | undefined;
    const poll = vi.spyOn(service, "pollOwnedMailboxes")
      .mockImplementationOnce(() => new Promise<void>(resolve => { releasePoll = resolve; }))
      .mockResolvedValue();

    service.start();
    await vi.advanceTimersByTimeAsync(4_500);
    expect(poll).toHaveBeenCalledTimes(1);
    service.start();
    await vi.advanceTimersByTimeAsync(5_500);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    releasePoll?.();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(4_500);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected idle poll and keeps polling", async () => {
    vi.useFakeTimers();
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "idle-rejection.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: Date.now,
    });
    service = new AgentMessagingService({ store, bridge, operatorSessionId: "session-a", random: () => 0 });
    const failure = new Error("poll failed");
    const poll = vi.spyOn(service, "pollOwnedMailboxes")
      .mockRejectedValueOnce(failure)
      .mockResolvedValue();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    service.start();
    await vi.advanceTimersByTimeAsync(4_500);
    expect(warn).toHaveBeenCalledWith("[pi-subagents] Agent messaging idle poll failed:", failure);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("defers store close until an active idle poll settles and does not reschedule", async () => {
    vi.useFakeTimers();
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "idle-close.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: Date.now,
    });
    service = new AgentMessagingService({ store, bridge, operatorSessionId: "session-a", random: () => 0 });
    service.registerAgent(registration("caller", "session-a", "caller"));
    service.registerAgent(registration("recipient", "session-a", "recipient"));
    store.enqueue({ id: "pending", fromAgent: "caller", toAgent: "recipient", kind: "message", body: "queued" });
    let releaseDelivery: (() => void) | undefined;
    bridge.deliver = vi.fn(async () => {
      await new Promise<void>(resolve => { releaseDelivery = resolve; });
      return { delivered: true, woken: false };
    });
    const closeStore = vi.spyOn(store, "close");

    service.start();
    await vi.advanceTimersByTimeAsync(4_500);
    expect(releaseDelivery).toBeTypeOf("function");
    service.close();
    expect(closeStore).not.toHaveBeenCalled();
    releaseDelivery?.();
    await vi.waitFor(() => expect(closeStore).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces a backlog into one notice carrying the count", async () => {
    // Five messages between two turn boundaries must cost the recipient one
    // interruption, not five (§6.1) — the count is what makes one line honest.
    service.registerAgent(registration("one", "session-a", "one"));
    service.registerAgent(registration("two", "session-a", "two"));
    service.registerAgent(registration("recipient", "session-a", "recipient"));
    store.enqueue({ id: "m1", fromAgent: "one", toAgent: "recipient", kind: "message", body: "a" });
    store.enqueue({ id: "m2", fromAgent: "two", toAgent: "recipient", kind: "request", body: "b" });

    await service.pollOwnedMailboxes();

    expect(bridge.deliveries).toHaveLength(1);
    expect(bridge.deliveries[0]?.content).toContain("one, two sent 2 messages; 2 unread");
    expect(store.listUndelivered("recipient")).toHaveLength(0);
  });

  it("sweeps the recipient's backlog into the send it was triggered by", async () => {
    service.registerAgent(registration("recipient", "session-a", "recipient"));
    store.enqueue({ id: "waiting", fromAgent: "caller", toAgent: "recipient", kind: "message", body: "older" });

    const sent = await service.send(caller, { to: "recipient", message: "newer" });

    expect(bridge.deliveries).toHaveLength(1);
    expect(bridge.deliveries[0]?.content).toContain("2 unread");
    expect(sent.receipt).toMatchObject({ status: "injected", surface: "notice" });
  });

  it("spends one wake on a whole batch", async () => {
    service.registerAgent(registration("idle", "session-a", "idle", { status: "settled" }));
    setInfo("idle", "ui", "settled");
    store.enqueue({ id: "w1", fromAgent: "caller", toAgent: "idle", kind: "message", body: "a" });
    store.enqueue({ id: "w2", fromAgent: "caller", toAgent: "idle", kind: "message", body: "b" });

    await service.pollOwnedMailboxes();

    expect(bridge.deliveries).toMatchObject([{ agentId: "idle", wake: true }]);
    expect(store.listUndelivered("idle")).toHaveLength(0);
  });

  it("caps how many bodies one context injection carries and defers the rest", async () => {
    // A notice coalesces for free; bodies do not, and a backlog at the 16 KiB
    // cap would spend more context than the recipient's own turn.
    service.registerAgent(registration("body", "session-a", "body"));
    setInfo("body", "context");
    for (let index = 0; index < 12; index++) {
      store.enqueue({ id: `b${index}`, fromAgent: "caller", toAgent: "body", kind: "message", body: `body-${index}` });
    }

    await service.pollOwnedMailboxes();
    const first = bridge.deliveries[0]!.content;
    await service.pollOwnedMailboxes();

    expect(first.match(/<peer_message:/g)).toHaveLength(10);
    expect(first).toContain("body-9");
    expect(first).not.toContain("body-10");
    expect(bridge.deliveries[1]?.content).toContain("body-11");
    expect(store.listUndelivered("body")).toHaveLength(0);
  });

  it("reports a deferred message as queued rather than delivered", async () => {
    service.registerAgent(registration("body", "session-a", "body"));
    setInfo("body", "context");
    for (let index = 0; index < 10; index++) {
      store.enqueue({ id: `q${index}`, fromAgent: "caller", toAgent: "body", kind: "message", body: `queued-${index}` });
    }

    const sent = await service.send(caller, { to: "body", message: "eleventh" });

    expect(sent.receipt).toMatchObject({ status: "queued", reason: "batch-deferred" });
  });

  it("reports bus traffic to a listener without letting it affect delivery", async () => {
    const activity: unknown[] = [];
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "activity.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: () => now,
    });
    bridge = new FakeBridge();
    service = new AgentMessagingService({
      store,
      bridge,
      operatorSessionId: "session-a",
      clock: () => now,
      onActivity: event => activity.push(event),
    });
    service.registerAgent(registration("caller", "session-a", "caller"));
    service.registerAgent(registration("recipient", "session-a", "recipient"));

    await service.send(caller, { to: "recipient", message: "hello" });
    service.boardPut(caller, { topic: "findings", key: "k", value: 1 });
    service.boardDelete(caller, "findings", "k");
    service.boardDelete(caller, "findings", "gone");
    const operator = service.operatorPut({ topic: "operator/rules", key: "limit", value: 1, expectedToken: null });
    if (operator.ok && operator.entry.entryToken !== null) {
      service.operatorExpire({
        topic: operator.entry.topic,
        key: operator.entry.key,
        expectedToken: operator.entry.entryToken,
      });
    }

    expect(activity).toMatchObject([
      { type: "message", fromLabel: "caller", toLabel: "recipient", kind: "message", body: "hello" },
      { type: "board", op: "put", topic: "findings", key: "k", author: "caller", revision: 1 },
      { type: "board", op: "delete", topic: "findings", key: "k" },
      {
        type: "board",
        op: "put",
        topic: "operator/rules",
        key: "limit",
        author: "operator",
        authorAgent: null,
        authorSession: "session-a",
      },
      { type: "board", op: "expire", topic: "operator/rules", key: "limit", authorAgent: null },
    ]);
  });

  it("exposes panel metadata and operator mutations with trusted provenance", () => {
    expect(service.getPanelInfo()).toMatchObject({
      scopeKey: "/project",
      scopeMode: "project",
      operatorTopicPrefix: "operator/",
      sessionId: "session-a",
      transport: "off",
    });
    expect(new NullNotifyBus().mode).toBe("off");

    const created = service.operatorPut({ topic: "operator/rules", key: "limit", value: 3, expectedToken: null });
    expect(created).toMatchObject({
      ok: true,
      entry: { author: "operator", authorAgentId: null, authorSessionId: "session-a" },
    });
    if (!created.ok || created.entry.entryToken === null) return;
    expect(service.operatorExpire({
      topic: created.entry.topic,
      key: created.entry.key,
      expectedToken: created.entry.entryToken,
    })).toMatchObject({ ok: true, op: "expire" });
    expect(service.boardRecentLog({ limit: 2 }).map(item => [item.op, item.authorSessionId])).toEqual([
      ["expire", "session-a"],
      ["put", "session-a"],
    ]);
  });

  it("keeps committed operator success when the activity listener throws", () => {
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "listener.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: () => now,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    service = new AgentMessagingService({
      store,
      bridge,
      operatorSessionId: "session-a",
      clock: () => now,
      onActivity: () => { throw new Error("listener failed"); },
    });

    const result = service.operatorPut({ topic: "operator/rules", key: "k", value: 1, expectedToken: null });

    expect(result.ok).toBe(true);
    expect(store.get("operator/rules", "k")?.value).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "[pi-subagents] Agent messaging activity listener failed:",
      expect.objectContaining({ message: "listener failed" }),
    );
  });

  it("filters expired data before maintenance and refreshes only owned presence before reaping", async () => {
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "maintenance.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: () => now,
      heartbeatTimeoutMs: 100,
      isProcessAlive: () => true,
    });
    bridge = new FakeBridge();
    service = new AgentMessagingService({ store, bridge, operatorSessionId: "session-a", clock: () => now });
    service.registerAgent(registration("owned", "session-a", "owned"));
    service.registerAgent(registration("foreign", "session-b", "foreign"));
    bridge.access.set("foreign", "read-only");
    store.enqueue({ id: "expired-message", fromAgent: "foreign", toAgent: "owned", kind: "message", body: "old", expiresAt: 1_050 });
    store.put({
      topic: "facts",
      key: "expired-entry",
      value: 1,
      author: "owned",
      authorAgentId: "owned",
      authorSessionId: "session-a",
      expiresAt: 1_050,
    });
    now = 1_101;

    expect(store.pendingCount("owned")).toBe(0);
    expect(service.boardGet("facts", "expired-entry")).toBeUndefined();
    await service.pollOwnedMailboxes();

    expect(store.listPeers().find(peer => peer.agentId === "owned")?.status).toBe("running");
    expect(store.listPeers().find(peer => peer.agentId === "foreign")?.status).toBe("gone");
    expect(store.readLog(0).at(-1)).toMatchObject({
      op: "expire",
      authorAgentId: "owned",
      authorSessionId: "session-a",
    });
  });

  it("does not redeliver rows already marked delivered", async () => {
    service.registerAgent(registration("recipient", "session-a", "recipient"));
    await service.send(caller, { to: "recipient", message: "once" });

    await service.pollOwnedMailboxes();

    expect(bridge.deliveries).toHaveLength(1);
  });

  it("leaves over-budget wake messages queued and refuses outbound hops over the cap", async () => {
    service.close();
    store = new SqliteStore({
      filePath: join(directory, "budget.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: () => now,
      maxHopCount: 1,
    });
    bridge = new FakeBridge();
    service = new AgentMessagingService({ store, bridge, operatorSessionId: "session-a", clock: () => now, maxWakesPerMinute: 1, maxHops: 1 });
    service.registerAgent(registration("caller", "session-a", "caller"));
    service.registerAgent(registration("idle", "session-a", "idle", { status: "settled" }));
    setInfo("idle", "ui", "settled");

    expect((await service.send(caller, { to: "idle", message: "first" })).receipt?.status).toBe("woken");
    expect(await service.send(caller, { to: "idle", message: "second" })).toMatchObject({
      ok: true,
      receipt: { status: "queued", reason: "wake-budget-exhausted" },
    });
    expect(store.pendingCount("idle")).toBe(2);
    expect(await service.send({ ...caller, hopCount: 2 }, { to: "idle", message: "loop" })).toEqual({
      ok: false,
      reason: "hop-cap-exceeded:1",
    });
  });

  it("carries a request correlation id onto its reply", async () => {
    service.registerAgent(registration("responder", "session-a", "responder"));
    const request = await service.send(caller, { to: "responder", message: "question", expectReply: true });
    const requestMessage = service.inbox({ agentId: "responder", sessionId: "session-a" })[0]!;

    const reply = await service.send(
      { agentId: "responder", sessionId: "session-a" },
      { to: "caller", message: "answer", replyTo: requestMessage.id },
    );
    const replyMessage = service.inbox(caller)[0]!;

    expect(request.receipt?.correlationId).toBeTruthy();
    expect(reply.receipt?.correlationId).toBe(request.receipt?.correlationId);
    expect(replyMessage).toMatchObject({ kind: "reply", replyTo: requestMessage.id });
  });

  it("broadcasts only to live subagents and never wakes them", async () => {
    service.registerAgent(registration("live", "session-a", "live"));
    service.registerAgent(registration("settled", "session-a", "settled", { status: "settled" }));
    service.registerAgent(registration("main:session-a", "session-a", "main-s", { kind: "main", type: "main" }));

    const sent = await service.broadcast(caller, "event");

    expect(sent.receipts.map(receipt => receipt.toAgent)).toEqual(["live"]);
    expect(bridge.deliveries).toMatchObject([{ agentId: "live", wake: false }]);
  });
});
