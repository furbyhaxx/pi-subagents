export const SCHEMA_VERSION = "1";

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id     TEXT PRIMARY KEY,
  handle       TEXT,
  alias        TEXT,
  type         TEXT NOT NULL,
  description  TEXT,
  parent_id    TEXT,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  session_file TEXT,
  created_at   INTEGER NOT NULL,
  seen_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_status ON agents(status, seen_at);
CREATE INDEX IF NOT EXISTS agents_handle ON agents(handle, session_id);

CREATE TABLE IF NOT EXISTS messages (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  body           TEXT NOT NULL,
  correlation_id TEXT,
  reply_to       TEXT,
  hop_count      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  delivered_at   INTEGER,
  consumed_at    INTEGER,
  dropped_at     INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_pending ON messages(to_agent, consumed_at, dropped_at, seq);
CREATE INDEX IF NOT EXISTS messages_correlation ON messages(correlation_id);

CREATE TABLE IF NOT EXISTS entries (
  topic       TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  author      TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  PRIMARY KEY (topic, key)
);
CREATE INDEX IF NOT EXISTS entries_topic ON entries(topic, updated_at);

CREATE TABLE IF NOT EXISTS entry_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  topic      TEXT NOT NULL,
  key        TEXT NOT NULL,
  op         TEXT NOT NULL,
  author     TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  value      TEXT,
  created_at INTEGER NOT NULL
);
`;

export const STORE_PRAGMAS = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
`;
