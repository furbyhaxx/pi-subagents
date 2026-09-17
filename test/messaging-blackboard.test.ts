/**
 * messaging-blackboard.test.ts — the `Blackboard` tool and the service surface
 * under it.
 *
 * The store's own rules (revisions, caps, the operator namespace) are pinned in
 * messaging-store.test.ts. What this file covers is what the tool adds on top:
 * authorship the caller cannot choose, a conflict that comes back as a readable
 * answer rather than an error, and a change feed whose cursor neither replays
 * history nor loses a row to a topic filter.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeDelivery, DeliveryBridge, RecipientDeliveryInfo } from "../src/messaging/delivery-bridge.js";
import { AgentMessagingService } from "../src/messaging/service.js";
import { SqliteStore } from "../src/messaging/store.js";
import { createBlackboardTool, createMessagingTools } from "../src/messaging/tool.js";
import type { AgentRegistration, AgentRow } from "../src/messaging/types.js";

/** The board never delivers anything, so an inert bridge is the whole seam. */
class InertBridge implements DeliveryBridge {
  recipientInfo(agent: AgentRow): RecipientDeliveryInfo {
    return { ownership: "local", state: "running", surface: "ui", kind: agent.kind, sessionId: agent.sessionId };
  }

  isNestedAgentId(): boolean {
    return false;
  }

  async deliver(): Promise<BridgeDelivery> {
    return { delivered: true, woken: false };
  }
}

describe("Blackboard", () => {
  let directory: string;
  let store: SqliteStore;
  let service: AgentMessagingService;

  const caller = { agentId: "agent-1", sessionId: "session-a" };
  const ctx = {} as ExtensionContext;

  function registration(agentId: string, handle: string): AgentRegistration {
    return {
      agentId,
      handle,
      sessionId: "session-a",
      kind: "sub",
      type: "Explore",
      status: "running",
      pid: process.pid,
    };
  }

  /** Every call goes through the tool, since that is the surface under test. */
  async function call(params: Record<string, unknown>): Promise<any> {
    const tool = createBlackboardTool(() => service, () => caller);
    const output = await tool.execute("tc", params as never, undefined, undefined, ctx);
    return JSON.parse(output.content[0]!.text);
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "messaging-blackboard-test-"));
    store = new SqliteStore({
      filePath: join(directory, "messaging.sqlite3"),
      scopeKey: "/project",
      scopeMode: "project",
      clock: Date.now,
    });
    service = new AgentMessagingService({ store, bridge: new InertBridge() });
    service.registerAgent(registration("agent-1", "explore"));
  });

  afterEach(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("registers the board alongside the mailbox", () => {
    const names = createMessagingTools(() => service, () => caller).map(tool => tool.name);
    expect(names).toEqual(["AgentMessage", "Blackboard"]);
  });

  it("stamps the caller's own handle and exposes no author parameter", async () => {
    // Authorship is assigned, not submitted: a tool that took an author would
    // let any agent sign as any peer, and the board is what humans audit.
    const properties = createBlackboardTool(() => service, () => caller).parameters.properties;
    expect(properties).not.toHaveProperty("author");

    const put = await call({ op: "put", topic: "findings", key: "auth-routes", value: { count: 3 } });

    expect(put).toMatchObject({ ok: true, entry: { author: "explore", revision: 1, value: { count: 3 } } });
  });

  it("answers a revision conflict with the current value, author and revision", async () => {
    await call({ op: "put", topic: "findings", key: "k", value: "first" });

    const stale = await call({ op: "put", topic: "findings", key: "k", value: "second", if_revision: 0 });

    expect(stale).toEqual({
      ok: false,
      reason: "revision-conflict",
      currentRevision: 1,
      currentValue: "first",
      author: "explore",
      updatedAt: expect.any(Number),
    });
    // Answerable, not fatal: the model has to be able to read the payload and
    // retry, so this must not come back flagged as a tool error.
    const tool = createBlackboardTool(() => service, () => caller);
    const output = await tool.execute("tc", { op: "put", topic: "findings", key: "k", value: "x", if_revision: 0 } as never, undefined, undefined, ctx);
    expect(output.isError).toBe(false);
    expect((await call({ op: "get", topic: "findings", key: "k" })).entry.value).toBe("first");
  });

  it("refuses both writes and deletes under the operator namespace", async () => {
    store.put({ topic: "operator/plan", key: "goal", value: "ship it", author: "operator" });

    const written = await call({ op: "put", topic: "operator/plan", key: "goal", value: "mine now" });
    const deleted = await call({ op: "delete", topic: "operator/plan", key: "goal" });

    expect(written).toMatchObject({ ok: false, reason: "read-only-namespace", currentValue: "ship it" });
    expect(deleted).toMatchObject({ ok: false, reason: "read-only-namespace" });
    expect(store.get("operator/plan", "goal")?.value).toBe("ship it");
  });

  it("does not let an agent handled 'operator' write the operator namespace", async () => {
    // A custom agent type can be named anything, so the reserved author has to
    // be unforgeable by naming rather than merely conventional.
    service.registerAgent(registration("agent-2", "operator"));
    const impostor = { agentId: "agent-2", sessionId: "session-a" };

    const own = service.boardPut(impostor, { topic: "findings", key: "k", value: 1 });
    const reserved = service.boardPut(impostor, { topic: "operator/plan", key: "goal", value: "mine" });

    expect(own).toMatchObject({ ok: true, entry: { author: "agent-2" } });
    expect(reserved).toMatchObject({ ok: false, reason: "read-only-namespace" });
  });

  it("watches from the present by default rather than replaying the log", async () => {
    await call({ op: "put", topic: "findings", key: "old", value: 1 });

    // No `since`: only what happens from here on, and nothing does.
    const quiet = await call({ op: "watch", timeout_ms: 0 });
    // `since: 0` is the explicit replay.
    const replay = await call({ op: "watch", since: 0, timeout_ms: 0 });

    expect(quiet.changes).toEqual([]);
    expect(quiet.cursor).toBe(replay.cursor);
    expect(replay.changes).toMatchObject([{ key: "old", op: "put", author: "explore" }]);
  });

  it("returns changes after the cursor and hands back one to continue from", async () => {
    const start = await call({ op: "watch", timeout_ms: 0 });
    await call({ op: "put", topic: "findings", key: "a", value: 1 });
    await call({ op: "delete", topic: "findings", key: "a" });

    const seen = await call({ op: "watch", since: start.cursor, timeout_ms: 0 });
    const next = await call({ op: "watch", since: seen.cursor, timeout_ms: 0 });

    expect(seen.changes.map((change: { op: string }) => change.op)).toEqual(["put", "delete"]);
    expect(next.changes).toEqual([]);
    expect(next.cursor).toBe(seen.cursor);
  });

  it("advances the cursor past changes its topic filter rejected", async () => {
    // Otherwise a watcher on a quiet topic re-scans every row another topic
    // writes, forever, and its cursor never moves.
    const start = await call({ op: "watch", timeout_ms: 0 });
    await call({ op: "put", topic: "other", key: "noise", value: 1 });

    const filtered = await call({ op: "watch", topic: "findings", since: start.cursor, timeout_ms: 0 });

    expect(filtered.changes).toEqual([]);
    expect(filtered.cursor).toBeGreaterThan(start.cursor);
  });

  it("blocks until a peer writes, then returns that change", async () => {
    const start = await call({ op: "watch", timeout_ms: 0 });
    const watching = call({ op: "watch", topic: "findings", since: start.cursor, timeout_ms: 5_000 });
    setTimeout(() => {
      service.boardPut({ agentId: "agent-2", sessionId: "session-a" }, { topic: "findings", key: "late", value: "done" });
    }, 20);

    const result = await watching;

    expect(result.changes).toMatchObject([{ key: "late", value: "done" }]);
  });

  it("lists entries by topic and reports a missing entry as null", async () => {
    await call({ op: "put", topic: "findings", key: "a", value: 1 });
    await call({ op: "put", topic: "other", key: "b", value: 2 });

    expect((await call({ op: "list", topic: "findings" })).entries).toHaveLength(1);
    expect((await call({ op: "list" })).entries).toHaveLength(2);
    expect((await call({ op: "get", topic: "findings", key: "missing" })).entry).toBeNull();
  });

  it("names the missing parameter instead of guessing at one", async () => {
    expect(await call({ op: "put", topic: "findings", key: "a" })).toEqual({
      ok: false,
      reason: "put-requires-topic-key-and-value",
    });
    expect(await call({ op: "get", topic: "findings" })).toEqual({ ok: false, reason: "get-requires-topic-and-key" });
  });
});
