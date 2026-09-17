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
import { AgentMessagingService } from "../src/messaging/service.js";
import { SqliteStore } from "../src/messaging/store.js";
import { createAgentMessageTool } from "../src/messaging/tool.js";
import type { AgentRegistration, AgentRow, MessagingSurface } from "../src/messaging/types.js";

class FakeBridge implements DeliveryBridge {
  nested = new Set<string>();
  info = new Map<string, RecipientDeliveryInfo>();
  deliveries: Array<{ agentId: string; content: string; wake: boolean }> = [];

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
    service = new AgentMessagingService({ store, bridge, clock: () => now });
    service.registerAgent(registration("caller", "session-a", "caller"));
  });

  afterEach(() => {
    service.close();
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
    service = new AgentMessagingService({ store, bridge, maxWaitMs: 25 });
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
    service = new AgentMessagingService({ store, bridge, clock: () => now, maxWakesPerMinute: 1, maxHops: 1 });
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
