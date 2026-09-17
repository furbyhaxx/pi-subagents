import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";

export type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;
export type SqlParams = Readonly<Record<string, SqlValue>>;
export type SqlRow = Record<string, SqlValue>;

export interface SqlRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(params: SqlParams): SqlRunResult;
  get(params: SqlParams): SqlRow | undefined;
  all(params: SqlParams): SqlRow[];
}

export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

const require = createRequire(import.meta.url);

function loadSqlite(): SqliteModule {
  // Loading through createRequire keeps this module importable on Node versions
  // that do not expose node:sqlite. The adapter is the only runtime boundary.
  return require("node:sqlite") as SqliteModule;
}

export function isSqliteAvailable(): boolean {
  try {
    loadSqlite();
    return true;
  } catch {
    return false;
  }
}

class NodeSqliteStatement implements SqliteStatement {
  constructor(private readonly statement: StatementSync) {}

  run(params: SqlParams): SqlRunResult {
    return this.statement.run(params);
  }

  get(params: SqlParams): SqlRow | undefined {
    return this.statement.get(params);
  }

  all(params: SqlParams): SqlRow[] {
    return this.statement.all(params);
  }
}

export class NodeSqliteDriver implements SqliteDriver {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    const { DatabaseSync } = loadSqlite();
    this.database = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.database.prepare(sql));
  }

  transaction<T>(fn: () => T): T {
    // IMMEDIATE, not deferred: every write transaction here reads before it writes
    // (revision checks, row lookups, sweep selects), and under project scope the
    // competing writer is another process. A deferred transaction takes a read
    // snapshot first and can then fail on upgrade with SQLITE_BUSY_SNAPSHOT,
    // which busy_timeout does not retry. Taking the write lock up front is the
    // documented way to make BUSY a problem of starting a transaction rather
    // than of finishing one. See https://sqlite.org/rescode.html#busy.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
