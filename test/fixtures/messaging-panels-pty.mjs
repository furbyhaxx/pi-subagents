#!/usr/bin/env node
/** Seed a hermetic messaging store for manual Blackboard/Peers PTY review. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { resolveMessagingLocation } from "../../dist/messaging/scope.js";
import { SqliteStore } from "../../dist/messaging/store.js";

const launchCwd = process.argv[2];
if (!launchCwd) throw new Error("usage: node test/fixtures/messaging-panels-pty.mjs <launch-cwd>");
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: launchCwd, encoding: "utf8" }).trim();
const projectRoot = basename(common) === ".git"
  ? dirname(common)
  : execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: launchCwd, encoding: "utf8" }).trim();
if (!process.env.PI_CODING_AGENT_DIR) throw new Error("PI_CODING_AGENT_DIR must point at a throwaway directory");

const now = Date.now();
const fixtureDir = join(process.env.PI_CODING_AGENT_DIR, "messaging-panel-fixture");
await mkdir(fixtureDir, { recursive: true });
const foreignFile = join(fixtureDir, "foreign-session.jsonl");
await writeFile(foreignFile, [
  JSON.stringify({ type: "message", role: "user", content: "Inspect the transport" }),
  JSON.stringify({ type: "message", role: "assistant", content: "Socket unavailable; polling safely" }),
  JSON.stringify({ type: "tool", name: "read", path: "src/messaging/service.ts" }),
].join("\n") + "\n", "utf8");

const location = resolveMessagingLocation({ originProjectRoot: projectRoot, mode: "project" });
const store = new SqliteStore({
  filePath: location.databasePath,
  scopeKey: location.scopeKey,
  scopeMode: location.mode,
  clock: () => now,
});
store.registerAgent({
  agentId: "foreign-reviewer",
  handle: "review",
  alias: "review",
  type: "code-reviewer",
  description: "Foreign read-only fixture",
  sessionId: "foreign-session-abcdef",
  kind: "sub",
  status: "idle",
  pid: process.pid + 10000,
  sessionFile: foreignFile,
});
store.put({
  topic: "findings",
  key: "transport",
  value: { mode: "polling", safe: true },
  author: "review",
  authorAgentId: "foreign-reviewer",
  authorSessionId: "foreign-session-abcdef",
});
store.operatorPut({
  topic: "operator/constraints",
  key: "no-live-models",
  value: "PTY fixture must stay offline",
  expectedToken: null,
  operatorSessionId: "fixture-operator-session",
});
store.close();
console.log(location.databasePath);
