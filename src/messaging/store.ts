import { NodeSqliteDriver, type SqliteDriver, type SqlRow } from "./driver.js";
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_VERSION, STORE_PRAGMAS } from "./schema.js";
import type {
  AgentRegistration,
  AgentRow,
  AgentStatus,
  BlackboardConflict,
  BlackboardDeleteResult,
  BlackboardEntry,
  BlackboardLogEntry,
  BlackboardPut,
  BlackboardPutResult,
  EnqueueMessage,
  EnqueueResult,
  MailboxDrop,
  MessageKind,
  MessageRow,
  MessagingStoreMetadata,
  OperatorDeleteResult,
  OperatorPutResult,
  SqliteStoreOptions,
} from "./types.js";

const EMPTY_PARAMS = {};
const ENTRY_COLUMNS = `entries.*,
  (SELECT seq FROM entry_log
   WHERE entry_log.topic=entries.topic AND entry_log.key=entries.key AND op='put'
   ORDER BY seq DESC LIMIT 1) AS entry_token`;

function text(row: SqlRow, key: string): string {
  return row[key] as string;
}

function nullableText(row: SqlRow, key: string): string | null {
  return (row[key] as string | null) ?? null;
}

function number(row: SqlRow, key: string): number {
  return Number(row[key]);
}

function nullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}

function messageFromRow(row: SqlRow): MessageRow {
  return {
    id: text(row, "id"),
    seq: number(row, "seq"),
    fromAgent: text(row, "from_agent"),
    toAgent: text(row, "to_agent"),
    kind: text(row, "kind") as MessageKind,
    body: text(row, "body"),
    correlationId: nullableText(row, "correlation_id"),
    replyTo: nullableText(row, "reply_to"),
    hopCount: number(row, "hop_count"),
    createdAt: number(row, "created_at"),
    expiresAt: nullableNumber(row, "expires_at"),
    deliveredAt: nullableNumber(row, "delivered_at"),
    consumedAt: nullableNumber(row, "consumed_at"),
    droppedAt: nullableNumber(row, "dropped_at"),
    attempts: number(row, "attempts"),
  };
}

function agentFromRow(row: SqlRow): AgentRow {
  return {
    agentId: text(row, "agent_id"),
    handle: nullableText(row, "handle") ?? undefined,
    alias: nullableText(row, "alias") ?? undefined,
    type: text(row, "type"),
    description: nullableText(row, "description") ?? undefined,
    parentId: nullableText(row, "parent_id") ?? undefined,
    sessionId: text(row, "session_id"),
    kind: text(row, "kind") as AgentRow["kind"],
    status: text(row, "status") as AgentStatus,
    pid: number(row, "pid"),
    sessionFile: nullableText(row, "session_file") ?? undefined,
    createdAt: number(row, "created_at"),
    seenAt: number(row, "seen_at"),
  };
}

function entryFromRow(row: SqlRow): BlackboardEntry {
  return {
    topic: text(row, "topic"),
    key: text(row, "key"),
    value: JSON.parse(text(row, "value")) as unknown,
    author: text(row, "author"),
    authorAgentId: nullableText(row, "author_agent_id"),
    authorSessionId: nullableText(row, "author_session_id"),
    entryToken: nullableNumber(row, "entry_token"),
    revision: number(row, "revision"),
    createdAt: number(row, "created_at"),
    updatedAt: number(row, "updated_at"),
    expiresAt: nullableNumber(row, "expires_at"),
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class SqliteStore {
  private readonly driver: SqliteDriver;
  private readonly clock: () => number;
  private readonly messageBodyLimitBytes: number;
  private readonly mailboxLimit: number;
  private readonly messageTtlMs: number;
  private readonly consumedRetentionMs: number;
  private readonly blackboardValueLimitBytes: number;
  private readonly blackboardKeysPerTopic: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxHopCount: number;
  private readonly operatorTopicPrefix: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly metadata: MessagingStoreMetadata;

  constructor(options: SqliteStoreOptions, driver?: SqliteDriver) {
    this.driver = driver ?? new NodeSqliteDriver(options.filePath);
    this.clock = options.clock;
    this.messageBodyLimitBytes = options.messageBodyLimitBytes ?? 16 * 1024;
    this.mailboxLimit = options.mailboxLimit ?? 200;
    this.messageTtlMs = options.messageTtlMs ?? 60 * 60_000;
    this.consumedRetentionMs = options.consumedRetentionMs ?? 24 * 60 * 60_000;
    this.blackboardValueLimitBytes = options.blackboardValueLimitBytes ?? 64 * 1024;
    this.blackboardKeysPerTopic = options.blackboardKeysPerTopic ?? 500;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000;
    this.maxHopCount = options.maxHopCount ?? 4;
    this.operatorTopicPrefix = options.operatorTopicPrefix ?? "operator/";
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.metadata = Object.freeze({
      scopeKey: options.scopeKey,
      scopeMode: options.scopeMode,
      databasePath: options.filePath,
      operatorTopicPrefix: this.operatorTopicPrefix,
    });

    try {
      this.driver.exec(STORE_PRAGMAS);
      this.driver.exec(SCHEMA_V1);
      this.initializeMeta(options.scopeKey, options.scopeMode);
      this.sweep();
    } catch (error) {
      this.driver.close();
      throw error;
    }
  }

  close(): void {
    this.driver.close();
  }

  getMetadata(): MessagingStoreMetadata {
    return this.metadata;
  }

  private initializeMeta(scopeKey: string, scopeMode: string): void {
    this.driver.transaction(() => {
      const rows = this.driver.prepare("SELECT key, value FROM meta").all(EMPTY_PARAMS);
      if (rows.length === 0) {
        const insert = this.driver.prepare("INSERT INTO meta(key, value) VALUES ($key, $value)");
        insert.run({ $key: "schema_version", $value: "1" });
        insert.run({ $key: "scope_key", $value: scopeKey });
        insert.run({ $key: "scope_mode", $value: scopeMode });
      }

      const reread = this.driver.prepare("SELECT key, value FROM meta").all(EMPTY_PARAMS);
      const meta = new Map(reread.map(row => [text(row, "key"), text(row, "value")]));
      if (meta.get("scope_mode") !== scopeMode) {
        throw new Error(`Messaging scope mode mismatch: stored ${meta.get("scope_mode")}, requested ${scopeMode}`);
      }
      if (meta.get("scope_key") !== scopeKey) {
        throw new Error("Messaging scope key does not match the requested scope");
      }
      const version = meta.get("schema_version");
      if (version === "1") {
        this.driver.exec(SCHEMA_V2);
        this.driver.prepare("UPDATE meta SET value=$version WHERE key='schema_version'").run({ $version: SCHEMA_VERSION });
      } else if (version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported messaging schema version: ${version ?? "missing"}`);
      }
    });
  }

  registerAgent(agent: AgentRegistration): AgentRow {
    const now = this.clock();
    this.driver.prepare(`
      INSERT INTO agents(
        agent_id, handle, alias, type, description, parent_id, session_id, kind, status,
        pid, session_file, created_at, seen_at
      ) VALUES (
        $agentId, $handle, $alias, $type, $description, $parentId, $sessionId, $kind, $status,
        $pid, $sessionFile, $now, $now
      )
      ON CONFLICT(agent_id) DO UPDATE SET
        handle=excluded.handle, alias=excluded.alias, type=excluded.type,
        description=excluded.description, parent_id=excluded.parent_id,
        session_id=excluded.session_id, kind=excluded.kind, status=excluded.status, pid=excluded.pid,
        session_file=excluded.session_file, seen_at=excluded.seen_at
    `).run({
      $agentId: agent.agentId,
      $handle: agent.handle ?? null,
      $alias: agent.alias ?? null,
      $type: agent.type,
      $description: agent.description ?? null,
      $parentId: agent.parentId ?? null,
      $sessionId: agent.sessionId,
      $kind: agent.kind,
      $status: agent.status,
      $pid: agent.pid,
      $sessionFile: agent.sessionFile ?? null,
      $now: now,
    });
    const row = this.driver.prepare("SELECT * FROM agents WHERE agent_id=$agentId").get({ $agentId: agent.agentId });
    if (!row) throw new Error(`Failed to register agent ${agent.agentId}`);
    return agentFromRow(row);
  }

  heartbeat(agentId: string): boolean {
    return Number(this.driver.prepare("UPDATE agents SET seen_at=$now WHERE agent_id=$agentId").run({
      $now: this.clock(),
      $agentId: agentId,
    }).changes) > 0;
  }

  setStatus(agentId: string, status: AgentStatus): boolean {
    return Number(this.driver.prepare("UPDATE agents SET status=$status, seen_at=$now WHERE agent_id=$agentId").run({
      $status: status,
      $now: this.clock(),
      $agentId: agentId,
    }).changes) > 0;
  }

  listPeers(): AgentRow[] {
    return this.driver.prepare("SELECT * FROM agents ORDER BY created_at, agent_id").all(EMPTY_PARAMS).map(agentFromRow);
  }

  reapStale(): string[] {
    const cutoff = this.clock() - this.heartbeatTimeoutMs;
    const stale = this.driver.prepare("SELECT * FROM agents WHERE status != 'gone'").all(EMPTY_PARAMS)
      .filter(row => number(row, "seen_at") < cutoff || !this.isProcessAlive(number(row, "pid")));
    if (stale.length === 0) return [];
    const update = this.driver.prepare("UPDATE agents SET status='gone' WHERE agent_id=$agentId");
    this.driver.transaction(() => {
      for (const row of stale) update.run({ $agentId: text(row, "agent_id") });
    });
    return stale.map(row => text(row, "agent_id"));
  }

  enqueue(message: EnqueueMessage): EnqueueResult {
    if (Buffer.byteLength(message.body, "utf8") > this.messageBodyLimitBytes) {
      throw new Error(`Message body exceeds ${this.messageBodyLimitBytes} bytes`);
    }
    const hopCount = message.hopCount ?? 0;
    if (hopCount > this.maxHopCount) throw new Error(`Message hop count exceeds ${this.maxHopCount}`);

    const recipients = message.toAgent === "all"
      ? this.driver.prepare(`
          SELECT agent_id FROM agents
          WHERE status IN ('queued', 'running', 'idle') AND kind='sub' AND agent_id != $sender
          ORDER BY agent_id
        `).all({ $sender: message.fromAgent }).map(row => text(row, "agent_id"))
      : [message.toAgent];
    const now = this.clock();
    const expiresAt = message.expiresAt === undefined ? now + this.messageTtlMs : message.expiresAt;

    return this.driver.transaction(() => {
      const inserted: MessageRow[] = [];
      const dropped: MailboxDrop[] = [];
      const insert = this.driver.prepare(`
        INSERT OR IGNORE INTO messages(
          id, from_agent, to_agent, kind, body, correlation_id, reply_to,
          hop_count, created_at, expires_at
        ) VALUES (
          $id, $fromAgent, $toAgent, $kind, $body, $correlationId, $replyTo,
          $hopCount, $now, $expiresAt
        )
      `);
      const get = this.driver.prepare("SELECT * FROM messages WHERE id=$id");
      for (const recipient of recipients) {
        const id = message.toAgent === "all" ? `${message.id}:${recipient}` : message.id;
        insert.run({
          $id: id,
          $fromAgent: message.fromAgent,
          $toAgent: recipient,
          $kind: message.kind,
          $body: message.body,
          $correlationId: message.correlationId ?? null,
          $replyTo: message.replyTo ?? null,
          $hopCount: hopCount,
          $now: now,
          $expiresAt: expiresAt,
        });
        const row = get.get({ $id: id });
        if (row) inserted.push(messageFromRow(row));
        dropped.push(...this.enforceMailboxCap(recipient, now));
      }
      return { messages: inserted, dropped };
    });
  }

  private enforceMailboxCap(agentId: string, now: number): MailboxDrop[] {
    const rows = this.driver.prepare(`
      SELECT id, to_agent FROM messages
      WHERE to_agent=$agentId AND consumed_at IS NULL AND dropped_at IS NULL
        AND (expires_at IS NULL OR expires_at>$now)
      ORDER BY seq DESC LIMIT -1 OFFSET $limit
    `).all({ $agentId: agentId, $limit: this.mailboxLimit, $now: now });
    const drop = this.driver.prepare(`
      UPDATE messages SET dropped_at=$now WHERE id=$id AND consumed_at IS NULL AND dropped_at IS NULL
    `);
    for (const row of rows) drop.run({ $now: now, $id: text(row, "id") });
    return rows.map(row => ({ id: text(row, "id"), toAgent: text(row, "to_agent"), droppedAt: now }));
  }

  getMessage(id: string): MessageRow | undefined {
    const row = this.driver.prepare("SELECT * FROM messages WHERE id=$id").get({ $id: id });
    return row ? messageFromRow(row) : undefined;
  }

  /**
   * Everything waiting to be put in front of one recipient, oldest first.
   *
   * Delivery works on the whole backlog rather than one row at a time so that
   * several messages arriving between two turn boundaries become one notice
   * with a count instead of one interruption each (§6.1).
   */
  listUndelivered(agentId: string, limit = 200): MessageRow[] {
    return this.driver.prepare(`
      SELECT * FROM messages
      WHERE to_agent=$agentId AND consumed_at IS NULL AND dropped_at IS NULL AND delivered_at IS NULL
        AND (expires_at IS NULL OR expires_at>$now)
      ORDER BY seq LIMIT $limit
    `).all({ $agentId: agentId, $limit: limit, $now: this.clock() }).map(messageFromRow);
  }

  consumeNext(agentId: string, options: { from?: string } = {}): MessageRow | undefined {
    const row = this.driver.prepare(`
      UPDATE messages SET consumed_at=$now
      WHERE id = (
        SELECT id FROM messages
        WHERE to_agent=$agentId AND consumed_at IS NULL AND dropped_at IS NULL
          AND (expires_at IS NULL OR expires_at>$now)
          AND ($fromAgent IS NULL OR from_agent=$fromAgent)
        ORDER BY seq LIMIT 1
      ) AND consumed_at IS NULL AND dropped_at IS NULL
      RETURNING *
    `).get({ $now: this.clock(), $agentId: agentId, $fromAgent: options.from ?? null });
    return row ? messageFromRow(row) : undefined;
  }

  drain(agentId: string, options: { peek?: boolean } = {}): MessageRow[] {
    if (options.peek) {
      return this.driver.prepare(`
        SELECT * FROM messages
        WHERE to_agent=$agentId AND consumed_at IS NULL AND dropped_at IS NULL
          AND (expires_at IS NULL OR expires_at>$now) ORDER BY seq
      `).all({ $agentId: agentId, $now: this.clock() }).map(messageFromRow);
    }
    const messages: MessageRow[] = [];
    while (true) {
      const next = this.consumeNext(agentId);
      if (!next) return messages;
      messages.push(next);
    }
  }

  markUndeliverable(id: string): boolean {
    return Number(this.driver.prepare(`
      UPDATE messages SET dropped_at=$now WHERE id=$id AND consumed_at IS NULL AND dropped_at IS NULL
    `).run({ $now: this.clock(), $id: id }).changes) > 0;
  }

  markDelivered(id: string): boolean {
    return Number(this.driver.prepare(`
      UPDATE messages SET delivered_at=COALESCE(delivered_at, $now), attempts=attempts+1 WHERE id=$id
    `).run({ $now: this.clock(), $id: id }).changes) > 0;
  }

  pendingCount(agentId: string): number {
    const row = this.driver.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE to_agent=$agentId AND consumed_at IS NULL AND dropped_at IS NULL
        AND (expires_at IS NULL OR expires_at>$now)
    `).get({ $agentId: agentId, $now: this.clock() });
    return row ? number(row, "count") : 0;
  }

  put(input: BlackboardPut): BlackboardPutResult {
    const encoded = JSON.stringify(input.value);
    if (encoded === undefined) throw new Error("Blackboard value must be JSON-serializable");
    if (Buffer.byteLength(encoded, "utf8") > this.blackboardValueLimitBytes) {
      throw new Error(`Blackboard value exceeds ${this.blackboardValueLimitBytes} bytes`);
    }

    return this.driver.transaction(() => {
      const storedRow = this.driver.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE topic=$topic AND key=$key`).get({
        $topic: input.topic,
        $key: input.key,
      });
      const currentRow = storedRow && (nullableNumber(storedRow, "expires_at") === null
        || nullableNumber(storedRow, "expires_at")! > this.clock()) ? storedRow : undefined;
      if (input.topic.startsWith(this.operatorTopicPrefix) && input.author !== "operator") {
        return this.conflict("read-only-namespace", currentRow);
      }
      const currentRevision = currentRow ? number(currentRow, "revision") : 0;
      if (input.ifRevision !== undefined && input.ifRevision !== currentRevision) {
        return this.conflict("revision-conflict", currentRow);
      }
      if (!currentRow) {
        const countRow = this.driver.prepare(`
          SELECT COUNT(*) AS count FROM entries
          WHERE topic=$topic AND (expires_at IS NULL OR expires_at>$now)
        `).get({ $topic: input.topic, $now: this.clock() });
        if (countRow && number(countRow, "count") >= this.blackboardKeysPerTopic) {
          throw new Error(`Blackboard topic exceeds ${this.blackboardKeysPerTopic} keys`);
        }
      }

      const now = this.clock();
      if (storedRow && !currentRow) this.expireEntryRow(storedRow, now);
      const revision = currentRevision + 1;
      this.driver.prepare(`
        INSERT INTO entries(
          topic, key, value, author, author_agent_id, author_session_id,
          revision, created_at, updated_at, expires_at
        ) VALUES (
          $topic, $key, $value, $author, $authorAgentId, $authorSessionId,
          $revision, $now, $now, $expiresAt
        )
        ON CONFLICT(topic, key) DO UPDATE SET
          value=excluded.value, author=excluded.author,
          author_agent_id=excluded.author_agent_id, author_session_id=excluded.author_session_id,
          revision=excluded.revision, updated_at=excluded.updated_at, expires_at=excluded.expires_at
      `).run({
        $topic: input.topic,
        $key: input.key,
        $value: encoded,
        $author: input.author,
        $authorAgentId: input.authorAgentId ?? null,
        $authorSessionId: input.authorSessionId ?? null,
        $revision: revision,
        $now: now,
        $expiresAt: input.expiresAt ?? null,
      });
      this.appendLog(
        input.topic,
        input.key,
        "put",
        input.author,
        input.authorAgentId ?? null,
        input.authorSessionId ?? null,
        revision,
        encoded,
        now,
      );
      const saved = this.driver.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE topic=$topic AND key=$key`).get({
        $topic: input.topic,
        $key: input.key,
      });
      if (!saved) throw new Error("Failed to save blackboard entry");
      return { ok: true, entry: entryFromRow(saved) };
    });
  }

  private conflict(reason: BlackboardConflict["reason"], row: SqlRow | undefined): BlackboardConflict {
    return {
      ok: false,
      reason,
      currentRevision: row ? number(row, "revision") : null,
      currentValue: row ? JSON.parse(text(row, "value")) as unknown : null,
      author: row ? text(row, "author") : null,
      updatedAt: row ? number(row, "updated_at") : null,
    };
  }

  get(topic: string, key: string): BlackboardEntry | undefined {
    const row = this.driver.prepare(`
      SELECT ${ENTRY_COLUMNS} FROM entries
      WHERE topic=$topic AND key=$key AND (expires_at IS NULL OR expires_at>$now)
    `).get({ $topic: topic, $key: key, $now: this.clock() });
    return row ? entryFromRow(row) : undefined;
  }

  list(topic?: string): BlackboardEntry[] {
    const now = this.clock();
    const rows = topic === undefined
      ? this.driver.prepare(`
          SELECT ${ENTRY_COLUMNS} FROM entries
          WHERE expires_at IS NULL OR expires_at>$now ORDER BY topic, updated_at, key
        `).all({ $now: now })
      : this.driver.prepare(`
          SELECT ${ENTRY_COLUMNS} FROM entries
          WHERE topic=$topic AND (expires_at IS NULL OR expires_at>$now) ORDER BY updated_at, key
        `).all({ $topic: topic, $now: now });
    return rows.map(entryFromRow);
  }

  delete(
    topic: string,
    key: string,
    author: string,
    authorAgentId: string | null = null,
    authorSessionId: string | null = null,
  ): BlackboardDeleteResult {
    return this.driver.transaction(() => {
      const row = this.driver.prepare(`
        SELECT * FROM entries
        WHERE topic=$topic AND key=$key AND (expires_at IS NULL OR expires_at>$now)
      `).get({ $topic: topic, $key: key, $now: this.clock() });
      if (topic.startsWith(this.operatorTopicPrefix) && author !== "operator") {
        return this.conflict("read-only-namespace", row);
      }
      if (!row) return { ok: true, deleted: false };
      this.driver.prepare("DELETE FROM entries WHERE topic=$topic AND key=$key").run({ $topic: topic, $key: key });
      this.appendLog(
        topic,
        key,
        "delete",
        author,
        authorAgentId,
        authorSessionId,
        number(row, "revision"),
        null,
        this.clock(),
      );
      return { ok: true, deleted: true };
    });
  }

  operatorPut(input: {
    topic: string;
    key: string;
    value: unknown;
    expectedToken: number | null;
    operatorSessionId: string;
  }): OperatorPutResult {
    const encoded = JSON.stringify(input.value);
    if (encoded === undefined) throw new Error("Blackboard value must be JSON-serializable");
    if (Buffer.byteLength(encoded, "utf8") > this.blackboardValueLimitBytes) {
      throw new Error(`Blackboard value exceeds ${this.blackboardValueLimitBytes} bytes`);
    }

    return this.driver.transaction(() => {
      const row = this.driver.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE topic=$topic AND key=$key`).get({
        $topic: input.topic,
        $key: input.key,
      });
      const live = row && (nullableNumber(row, "expires_at") === null
        || Number(row.expires_at) > this.clock()) ? row : undefined;
      const current = live ? entryFromRow(live) : null;
      if (!input.topic.startsWith(this.operatorTopicPrefix)) {
        return { ok: false, reason: "read-only-namespace", current };
      }
      if (input.expectedToken === null) {
        if (live) return { ok: false, reason: "entry-changed", current };
      } else {
        if (!live) return { ok: false, reason: "not-found", current: null };
        if (current?.entryToken !== input.expectedToken) {
          return { ok: false, reason: "entry-changed", current };
        }
        if (text(live, "author") !== "operator"
          || nullableText(live, "author_agent_id") !== null
          || nullableText(live, "author_session_id") !== input.operatorSessionId) {
          return { ok: false, reason: "not-operator-authored", current };
        }
      }

      const now = this.clock();
      if (row && !live) this.expireEntryRow(row, now);
      const revision = live ? number(live, "revision") + 1 : 1;
      const createdAt = live ? number(live, "created_at") : now;
      const expiresAt = live ? nullableNumber(live, "expires_at") : null;
      this.driver.prepare(`
        INSERT INTO entries(
          topic, key, value, author, author_agent_id, author_session_id,
          revision, created_at, updated_at, expires_at
        ) VALUES (
          $topic, $key, $value, 'operator', NULL, $operatorSessionId,
          $revision, $createdAt, $now, $expiresAt
        )
        ON CONFLICT(topic, key) DO UPDATE SET
          value=excluded.value, author=excluded.author,
          author_agent_id=NULL, author_session_id=excluded.author_session_id,
          revision=excluded.revision, created_at=excluded.created_at,
          updated_at=excluded.updated_at, expires_at=excluded.expires_at
      `).run({
        $topic: input.topic,
        $key: input.key,
        $value: encoded,
        $operatorSessionId: input.operatorSessionId,
        $revision: revision,
        $createdAt: createdAt,
        $now: now,
        $expiresAt: expiresAt,
      });
      this.appendLog(
        input.topic,
        input.key,
        "put",
        "operator",
        null,
        input.operatorSessionId,
        revision,
        encoded,
        now,
      );
      const saved = this.driver.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE topic=$topic AND key=$key`).get({
        $topic: input.topic,
        $key: input.key,
      });
      if (!saved) throw new Error("Failed to save operator blackboard entry");
      return { ok: true, entry: entryFromRow(saved) };
    });
  }

  operatorDelete(input: {
    topic: string;
    key: string;
    expectedToken: number;
    operatorSessionId: string;
  }): OperatorDeleteResult {
    return this.operatorRemove({ ...input, op: "delete" });
  }

  operatorExpire(input: {
    topic: string;
    key: string;
    expectedToken: number;
    operatorSessionId: string;
  }): OperatorDeleteResult {
    return this.operatorRemove({ ...input, op: "expire" });
  }

  private operatorRemove(input: {
    topic: string;
    key: string;
    expectedToken: number;
    operatorSessionId: string;
    op: "delete" | "expire";
  }): OperatorDeleteResult {
    return this.driver.transaction(() => {
      const row = this.driver.prepare(`
        SELECT ${ENTRY_COLUMNS} FROM entries
        WHERE topic=$topic AND key=$key AND (expires_at IS NULL OR expires_at>$now)
      `).get({ $topic: input.topic, $key: input.key, $now: this.clock() });
      if (!row) return { ok: false, reason: "not-found", current: null };
      const entry = entryFromRow(row);
      if (entry.entryToken !== input.expectedToken) {
        return { ok: false, reason: "entry-changed", current: entry };
      }
      this.driver.prepare("DELETE FROM entries WHERE topic=$topic AND key=$key").run({
        $topic: input.topic,
        $key: input.key,
      });
      this.appendLog(
        input.topic,
        input.key,
        input.op,
        "operator",
        null,
        input.operatorSessionId,
        entry.revision,
        null,
        this.clock(),
      );
      return { ok: true, op: input.op, entry };
    });
  }

  boardRecentLog(options: { topic?: string; limit?: number } = {}): BlackboardLogEntry[] {
    const requested = Number.isFinite(options.limit) ? Math.trunc(options.limit ?? 100) : 100;
    const limit = Math.min(200, Math.max(1, requested));
    const rows = options.topic === undefined
      ? this.driver.prepare("SELECT * FROM entry_log ORDER BY seq DESC LIMIT $limit").all({ $limit: limit })
      : this.driver.prepare(`
          SELECT * FROM entry_log WHERE topic=$topic ORDER BY seq DESC LIMIT $limit
        `).all({ $topic: options.topic, $limit: limit });
    return rows.map(row => this.logFromRow(row));
  }

  readLog(since: number): BlackboardLogEntry[] {
    return this.driver.prepare("SELECT * FROM entry_log WHERE seq>$since ORDER BY seq").all({ $since: since })
      .map(row => this.logFromRow(row));
  }

  private logFromRow(row: SqlRow): BlackboardLogEntry {
    return {
      seq: number(row, "seq"),
      topic: text(row, "topic"),
      key: text(row, "key"),
      op: text(row, "op") as BlackboardLogEntry["op"],
      author: text(row, "author"),
      authorAgentId: nullableText(row, "author_agent_id"),
      authorSessionId: nullableText(row, "author_session_id"),
      revision: number(row, "revision"),
      value: nullableText(row, "value") === null ? null : JSON.parse(text(row, "value")) as unknown,
      createdAt: number(row, "created_at"),
    };
  }

  /**
   * The newest `entry_log.seq`, so a watcher can start from "now" rather than
   * replaying the whole history of the board on its first call. `seq` is an
   * AUTOINCREMENT column, so this never goes backwards after a sweep and a
   * cursor taken here stays valid.
   */
  currentLogSeq(): number {
    const row = this.driver.prepare("SELECT MAX(seq) AS seq FROM entry_log").get(EMPTY_PARAMS);
    return row && row.seq !== null ? number(row, "seq") : 0;
  }

  private appendLog(
    topic: string,
    key: string,
    op: BlackboardLogEntry["op"],
    author: string,
    authorAgentId: string | null,
    authorSessionId: string | null,
    revision: number,
    value: string | null,
    createdAt: number,
  ): void {
    this.driver.prepare(`
      INSERT INTO entry_log(
        topic, key, op, author, author_agent_id, author_session_id, revision, value, created_at
      ) VALUES (
        $topic, $key, $op, $author, $authorAgentId, $authorSessionId, $revision, $value, $createdAt
      )
    `).run({
      $topic: topic,
      $key: key,
      $op: op,
      $author: author,
      $authorAgentId: authorAgentId,
      $authorSessionId: authorSessionId,
      $revision: revision,
      $value: value,
      $createdAt: createdAt,
    });
  }

  private expireEntryRow(row: SqlRow, now: number): void {
    this.driver.prepare("DELETE FROM entries WHERE topic=$topic AND key=$key").run({
      $topic: text(row, "topic"),
      $key: text(row, "key"),
    });
    this.appendLog(
      text(row, "topic"),
      text(row, "key"),
      "expire",
      text(row, "author"),
      nullableText(row, "author_agent_id"),
      nullableText(row, "author_session_id"),
      number(row, "revision"),
      null,
      now,
    );
  }

  sweep(): { expiredMessages: number; expiredEntries: number; prunedMessages: number } {
    const now = this.clock();
    return this.driver.transaction(() => {
      const expiredEntries = this.driver.prepare("SELECT * FROM entries WHERE expires_at IS NOT NULL AND expires_at<=$now")
        .all({ $now: now });
      for (const row of expiredEntries) this.expireEntryRow(row, now);
      const expiredMessages = this.driver.prepare("DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at<=$now")
        .run({ $now: now });
      const prunedMessages = this.driver.prepare(`
        DELETE FROM messages WHERE consumed_at IS NOT NULL AND consumed_at<=$cutoff
      `).run({ $cutoff: now - this.consumedRetentionMs });
      return {
        expiredMessages: Number(expiredMessages.changes),
        expiredEntries: expiredEntries.length,
        prunedMessages: Number(prunedMessages.changes),
      };
    });
  }
}
