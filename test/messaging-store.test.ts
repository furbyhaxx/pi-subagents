import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSqliteAvailable, NodeSqliteDriver } from "../src/messaging/driver.js";
import { SCHEMA_V1 } from "../src/messaging/schema.js";
import { resolveMessagingLocation } from "../src/messaging/scope.js";
import { SqliteStore } from "../src/messaging/store.js";
import type { SqliteStoreOptions } from "../src/messaging/types.js";

const sqliteAvailable = isSqliteAvailable();

describe("resolveMessagingLocation", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "messaging-scope-test-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("resolves relative overrides against the real origin project", () => {
    const project = join(directory, "project");
    mkdirSync(project);
    const location = resolveMessagingLocation({ originProjectRoot: project, directory: ".state/messages" });

    expect(location.scopeKey).toBe(realpathSync(project));
    expect(location.databasePath).toBe(join(project, ".state/messages/messaging.sqlite3"));
    if (process.platform !== "win32") expect(statSync(location.directory).mode & 0o777).toBe(0o700);
  });

  it("places project stores under PI_CODING_AGENT_DIR with a readable hashed directory", () => {
    const project = join(directory, "my repo");
    const agentDirectory = join(directory, "agent-home");
    mkdirSync(project);
    const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    try {
      const location = resolveMessagingLocation({ originProjectRoot: project });
      expect(location.directory).toMatch(new RegExp(`^${agentDirectory}/messaging/my-repo-[a-f0-9]{6}$`));
      expect(location.scopeKey).toBe(realpathSync(project));
    } finally {
      if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
    }
  });

  it("places session stores under their frozen artifact root and keys them by session", () => {
    const project = join(directory, "project");
    const artifactRoot = join(directory, "artifacts");
    mkdirSync(project);
    const location = resolveMessagingLocation({
      originProjectRoot: project,
      mode: "session",
      rootSessionId: "session-1",
      artifactRoot,
    });

    expect(location.databasePath).toBe(join(artifactRoot, "messaging", "messaging.sqlite3"));
    expect(location.scopeKey).toBe(`${realpathSync(project)}\0session-1`);
  });
});

function message(id: string, toAgent = "recipient") {
  return {
    id,
    fromAgent: "sender",
    toAgent,
    kind: "message" as const,
    body: `body-${id}`,
  };
}

describe.skipIf(!sqliteAvailable)(
  `SqliteStore${sqliteAvailable ? "" : " (skipped: node:sqlite unavailable on this Node runtime)"}`,
  () => {
  let directory: string;
  let filePath: string;
  let now: number;
  const stores: SqliteStore[] = [];

  function open(overrides: Partial<SqliteStoreOptions> = {}): SqliteStore {
    const store = new SqliteStore({
      filePath,
      scopeKey: "/project",
      scopeMode: "project",
      clock: () => now,
      ...overrides,
    });
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "messaging-store-test-"));
    filePath = join(directory, "messaging.sqlite3");
    now = 1_000;
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("consumes one message only once across two store connections", () => {
    const first = open();
    const second = open();
    first.enqueue(message("m1"));

    const results = [first.consumeNext("recipient"), second.consumeNext("recipient")];

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)?.id).toBe("m1");
    expect(first.pendingCount("recipient")).toBe(0);
  });

  it("evicts the oldest pending message as a drop rather than a consume", () => {
    const store = open({ mailboxLimit: 2 });
    store.enqueue(message("m1"));
    store.enqueue(message("m2"));
    const result = store.enqueue(message("m3"));

    expect(result.dropped).toEqual([{ id: "m1", toAgent: "recipient", droppedAt: now }]);
    expect(store.pendingCount("recipient")).toBe(2);
    expect(store.drain("recipient", { peek: true }).map(item => item.id)).toEqual(["m2", "m3"]);
    expect(store.consumeNext("recipient")?.id).toBe("m2");
    const dropped = store.enqueue(message("m1")).messages[0];
    const consumed = store.enqueue(message("m2")).messages[0];
    expect(dropped).toMatchObject({ id: "m1", consumedAt: null, droppedAt: now });
    expect(consumed).toMatchObject({ id: "m2", consumedAt: now, droppedAt: null });
  });

  it("keeps message sequence numbers increasing after a sweep empties the table", () => {
    const store = open();
    const before = [
      store.enqueue({ ...message("a"), expiresAt: 1_100 }).messages[0]?.seq,
      store.enqueue({ ...message("b"), expiresAt: 1_100 }).messages[0]?.seq,
      store.enqueue({ ...message("c"), expiresAt: 1_100 }).messages[0]?.seq,
    ];
    now = 1_100;
    store.sweep();

    const after = store.enqueue(message("d")).messages[0]?.seq;

    expect(before).toEqual([1, 2, 3]);
    expect(after).toBe(4);
  });

  it("sweeps expired messages and entries while retaining unexpired data", () => {
    const store = open();
    store.enqueue({ ...message("expired"), expiresAt: 1_100 });
    store.enqueue({ ...message("live"), expiresAt: 2_000 });
    store.put({ topic: "facts", key: "expired", value: 1, author: "agent", expiresAt: 1_100 });
    store.put({ topic: "facts", key: "live", value: 2, author: "agent", expiresAt: 2_000 });
    now = 1_100;

    const sweepingStore = open();

    expect(sweepingStore.drain("recipient", { peek: true }).map(item => item.id)).toEqual(["live"]);
    expect(sweepingStore.list("facts").map(entry => entry.key)).toEqual(["live"]);
    expect(sweepingStore.readLog(0).map(entry => entry.op)).toEqual(["put", "put", "expire"]);
  });

  it("returns the current entry when an optimistic write loses", () => {
    const store = open();
    store.put({ topic: "facts", key: "answer", value: { answer: 41 }, author: "first" });
    now = 2_000;
    const updated = store.put({
      topic: "facts",
      key: "answer",
      value: { answer: 42 },
      author: "winner",
      ifRevision: 1,
    });
    expect(updated.ok).toBe(true);
    now = 3_000;

    const conflict = store.put({
      topic: "facts",
      key: "answer",
      value: { answer: 0 },
      author: "loser",
      ifRevision: 1,
    });

    expect(conflict).toEqual({
      ok: false,
      reason: "revision-conflict",
      currentRevision: 2,
      currentValue: { answer: 42 },
      author: "winner",
      updatedAt: 2_000,
    });
    expect(store.get("facts", "answer")?.value).toEqual({ answer: 42 });
  });

  it("rejects agent writes to the configurable operator namespace with conflict context", () => {
    const store = open({ operatorTopicPrefix: "human/" });
    const absent = store.put({ topic: "human/rules", key: "limit", value: 1, author: "agent" });
    expect(absent).toEqual({
      ok: false,
      reason: "read-only-namespace",
      currentRevision: null,
      currentValue: null,
      author: null,
      updatedAt: null,
    });

    now = 2_000;
    expect(store.put({ topic: "human/rules", key: "limit", value: 3, author: "operator" }).ok).toBe(true);
    const conflict = store.put({ topic: "human/rules", key: "limit", value: 2, author: "agent" });
    expect(conflict).toEqual({
      ok: false,
      reason: "read-only-namespace",
      currentRevision: 1,
      currentValue: 3,
      author: "operator",
      updatedAt: 2_000,
    });
  });

  it("throws when an existing database is opened with a different scope mode", () => {
    open().close();
    stores.length = 0;

    expect(() => open({ scopeMode: "session" })).toThrow(/scope mode mismatch/);
  });

  it("fans broadcasts out only to live agents structurally marked as subagents", () => {
    const store = open();
    const baseAgent = {
      kind: "sub" as const,
      type: "explorer",
      sessionId: "session",
      status: "running" as const,
      pid: process.pid,
    };
    store.registerAgent({ ...baseAgent, agentId: "sender" });
    store.registerAgent({ ...baseAgent, agentId: "live" });
    store.registerAgent({ ...baseAgent, agentId: "settled", status: "settled" });
    store.registerAgent({ ...baseAgent, agentId: "named-main", type: "main" });
    store.registerAgent({ ...baseAgent, agentId: "actual-main", kind: "main", type: "orchestrator" });

    const result = store.enqueue(message("broadcast", "all"));

    expect(result.messages.map(item => item.toAgent)).toEqual(["live", "named-main"]);
    expect(result.messages.every(item => item.toAgent !== "all")).toBe(true);
  });

  it("supports filtered consumption, delivery receipts, and non-consuming drains", () => {
    const store = open();
    store.enqueue({ ...message("other"), fromAgent: "other" });
    store.enqueue(message("wanted"));

    expect(store.consumeNext("recipient", { from: "sender" })?.id).toBe("wanted");
    expect(store.markDelivered("other")).toBe(true);
    const pending = store.drain("recipient", { peek: true });
    expect(pending.map(item => item.id)).toEqual(["other"]);
    expect(pending[0]?.deliveredAt).toBe(now);
    expect(store.pendingCount("recipient")).toBe(1);
  });

  it("audits blackboard puts, deletes, and log cursors", () => {
    const store = open();
    store.put({ topic: "facts", key: "a", value: { n: 1 }, author: "agent" });
    now = 2_000;
    store.put({ topic: "facts", key: "b", value: { n: 2 }, author: "agent" });
    const cursor = store.readLog(0)[0]?.seq ?? 0;

    expect(store.delete("facts", "a", "operator")).toEqual({ ok: true, deleted: true });
    expect(store.delete("facts", "missing", "operator")).toEqual({ ok: true, deleted: false });
    expect(store.list("facts").map(entry => entry.key)).toEqual(["b"]);
    expect(store.readLog(cursor).map(entry => [entry.op, entry.key])).toEqual([
      ["put", "b"],
      ["delete", "a"],
    ]);
  });

  it("refuses agent deletes under the operator prefix while allowing operator deletes", () => {
    const store = open();
    store.put({ topic: "operator/rules", key: "limit", value: 3, author: "operator" });

    expect(store.delete("operator/rules", "limit", "explore-2")).toEqual({
      ok: false,
      reason: "read-only-namespace",
      currentRevision: 1,
      currentValue: 3,
      author: "operator",
      updatedAt: now,
    });
    expect(store.get("operator/rules", "limit")?.value).toBe(3);
    expect(store.delete("operator/rules", "limit", "operator")).toEqual({ ok: true, deleted: true });
    expect(store.get("operator/rules", "limit")).toBeUndefined();
  });

  it("migrates v1 provenance additively without inferring legacy identity", () => {
    const driver = new NodeSqliteDriver(filePath);
    driver.exec(SCHEMA_V1);
    driver.prepare("INSERT INTO meta(key,value) VALUES ($key,$value)").run({ $key: "schema_version", $value: "1" });
    driver.prepare("INSERT INTO meta(key,value) VALUES ($key,$value)").run({ $key: "scope_key", $value: "/project" });
    driver.prepare("INSERT INTO meta(key,value) VALUES ($key,$value)").run({ $key: "scope_mode", $value: "project" });
    driver.prepare(`
      INSERT INTO entries(topic,key,value,author,revision,created_at,updated_at)
      VALUES ('facts','legacy','1','operator',4,10,20)
    `).run({});
    driver.prepare(`
      INSERT INTO entry_log(topic,key,op,author,revision,value,created_at)
      VALUES ('facts','legacy','put','operator',4,'1',20)
    `).run({});
    driver.close();

    const first = open();
    const legacy = first.get("facts", "legacy");
    expect(legacy).toMatchObject({ revision: 4, authorAgentId: null, authorSessionId: null, entryToken: 1 });
    first.close();
    stores.splice(stores.indexOf(first), 1);
    expect(() => open()).not.toThrow();
  });

  it("persists trusted agent provenance independently of the roster", () => {
    const first = open();
    first.put({
      topic: "facts",
      key: "owned",
      value: 1,
      author: "explore",
      authorAgentId: "agent-1",
      authorSessionId: "session-a",
    });
    first.close();
    stores.splice(stores.indexOf(first), 1);

    expect(open().get("facts", "owned")).toMatchObject({
      authorAgentId: "agent-1",
      authorSessionId: "session-a",
    });
  });

  it("uses nonreused put tokens to reject stale operator ABA actions atomically", () => {
    const first = open({ operatorTopicPrefix: "human/" });
    const second = open({ operatorTopicPrefix: "human/" });
    const created = first.operatorPut({
      topic: "human/rules", key: "limit", value: 1, expectedToken: null, operatorSessionId: "session-a",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const selectedToken = created.entry.entryToken;
    expect(selectedToken).not.toBeNull();
    if (selectedToken === null) return;
    const afterCreate = first.readLog(0);
    expect(first.operatorPut({
      topic: "human/rules", key: "limit", value: 9, expectedToken: null, operatorSessionId: "session-a",
    })).toMatchObject({ ok: false, reason: "entry-changed", current: { value: 1 } });
    expect(first.readLog(0)).toEqual(afterCreate);

    const edited = second.operatorPut({
      topic: "human/rules", key: "limit", value: 2, expectedToken: selectedToken, operatorSessionId: "session-a",
    });
    expect(edited.ok).toBe(true);
    const beforeRefusal = first.readLog(0);
    expect(first.operatorDelete({
      topic: "human/rules", key: "limit", expectedToken: selectedToken, operatorSessionId: "session-a",
    })).toMatchObject({ ok: false, reason: "entry-changed", current: { value: 2 } });
    expect(first.readLog(0)).toEqual(beforeRefusal);

    if (!edited.ok || edited.entry.entryToken === null) return;
    expect(second.operatorDelete({
      topic: "human/rules", key: "limit", expectedToken: edited.entry.entryToken, operatorSessionId: "session-a",
    })).toMatchObject({ ok: true, op: "delete" });
    const recreated = second.operatorPut({
      topic: "human/rules", key: "limit", value: 3, expectedToken: null, operatorSessionId: "session-a",
    });
    expect(recreated).toMatchObject({ ok: true, entry: { revision: 1 } });
    expect(first.operatorExpire({
      topic: "human/rules", key: "limit", expectedToken: selectedToken, operatorSessionId: "session-a",
    })).toMatchObject({ ok: false, reason: "entry-changed", current: { value: 3, revision: 1 } });
  });

  it("requires current trusted operator provenance for edits and bounds recent log in SQL", () => {
    const store = open();
    store.put({ topic: "operator/rules", key: "legacy", value: 1, author: "operator" });
    const legacy = store.get("operator/rules", "legacy")!;
    expect(store.operatorPut({
      topic: legacy.topic,
      key: legacy.key,
      value: 2,
      expectedToken: legacy.entryToken,
      operatorSessionId: "session-a",
    })).toMatchObject({ ok: false, reason: "not-operator-authored" });
    expect(store.operatorPut({
      topic: "facts", key: "outside", value: 1, expectedToken: null, operatorSessionId: "session-a",
    })).toMatchObject({ ok: false, reason: "read-only-namespace" });
    for (let index = 0; index < 5; index++) {
      store.put({ topic: index % 2 ? "other" : "facts", key: `k${index}`, value: index, author: "agent" });
    }
    expect(store.boardRecentLog({ topic: "facts", limit: 2 }).map(item => item.key)).toEqual(["k4", "k2"]);
    expect(store.boardRecentLog({ limit: 1 })).toHaveLength(1);
  });

  it("enforces injectable payload, key, and hop limits", () => {
    const store = open({
      messageBodyLimitBytes: 4,
      blackboardValueLimitBytes: 8,
      blackboardKeysPerTopic: 1,
      maxHopCount: 1,
    });

    expect(() => store.enqueue({ ...message("large"), body: "12345" })).toThrow(/Message body/);
    expect(() => store.enqueue({ ...message("hop"), body: "ok", hopCount: 2 })).toThrow(/hop count/);
    expect(store.put({ topic: "facts", key: "a", value: 1, author: "agent" }).ok).toBe(true);
    expect(() => store.put({ topic: "facts", key: "b", value: 2, author: "agent" })).toThrow(/1 keys/);
    expect(() => store.put({ topic: "other", key: "a", value: "1234567", author: "agent" })).toThrow(
      /Blackboard value/,
    );
  });

  it("treats EPERM from a process probe as proof the owner is alive", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    try {
      const store = open();
      store.registerAgent({
        agentId: "foreign-owner",
        kind: "sub",
        type: "explorer",
        sessionId: "session",
        status: "running",
        pid: 2,
      });

      expect(store.reapStale()).toEqual([]);
      expect(store.listPeers()[0]?.status).toBe("running");
    } finally {
      kill.mockRestore();
    }
  });

  it("treats ESRCH from a process probe as a dead owner", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });
    try {
      const store = open();
      store.registerAgent({
        agentId: "missing-owner",
        kind: "sub",
        type: "explorer",
        sessionId: "session",
        status: "running",
        pid: 2,
      });

      expect(store.reapStale()).toEqual(["missing-owner"]);
      expect(store.listPeers()[0]?.status).toBe("gone");
    } finally {
      kill.mockRestore();
    }
  });

  it("reaps agents with dead owners or stale heartbeats", () => {
    const store = open({ heartbeatTimeoutMs: 100, isProcessAlive: pid => pid === 1 });
    store.registerAgent({
      agentId: "dead",
      kind: "sub",
      type: "explorer",
      sessionId: "session",
      status: "running",
      pid: 2,
    });
    store.registerAgent({
      agentId: "stale",
      kind: "sub",
      type: "explorer",
      sessionId: "session",
      status: "idle",
      pid: 1,
    });
    now = 1_101;

    expect(store.reapStale().sort()).toEqual(["dead", "stale"]);
    expect(store.listPeers().map(agent => agent.status)).toEqual(["gone", "gone"]);
  });
  },
);
