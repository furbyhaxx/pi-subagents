import type { MessagingScopeMode } from "./scope.js";

export type AgentStatus = "queued" | "running" | "idle" | "settled" | "gone";
export type AgentKind = "main" | "sub";
export type MessageKind = "message" | "request" | "reply" | "event";
export type MessagingSurface = "off" | "ui" | "context";

export interface AgentRegistration {
  agentId: string;
  handle?: string;
  alias?: string;
  type: string;
  description?: string;
  parentId?: string;
  sessionId: string;
  kind: AgentKind;
  status: AgentStatus;
  pid: number;
  sessionFile?: string;
}

export interface AgentRow extends AgentRegistration {
  createdAt: number;
  seenAt: number;
}

export interface EnqueueMessage {
  id: string;
  fromAgent: string;
  toAgent: string | "all";
  kind: MessageKind;
  body: string;
  correlationId?: string;
  replyTo?: string;
  hopCount?: number;
  expiresAt?: number | null;
}

export interface MessageRow {
  id: string;
  seq: number;
  fromAgent: string;
  toAgent: string;
  kind: MessageKind;
  body: string;
  correlationId: string | null;
  replyTo: string | null;
  hopCount: number;
  createdAt: number;
  expiresAt: number | null;
  deliveredAt: number | null;
  consumedAt: number | null;
  droppedAt: number | null;
  attempts: number;
}

export interface MailboxDrop {
  id: string;
  toAgent: string;
  droppedAt: number;
}

export interface EnqueueResult {
  messages: MessageRow[];
  dropped: MailboxDrop[];
}

export interface BlackboardEntry {
  topic: string;
  key: string;
  value: unknown;
  author: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface BlackboardLogEntry {
  seq: number;
  topic: string;
  key: string;
  op: "put" | "delete" | "expire";
  author: string;
  revision: number;
  value: unknown | null;
  createdAt: number;
}

export interface BlackboardPut {
  topic: string;
  key: string;
  value: unknown;
  author: string;
  ifRevision?: number;
  expiresAt?: number | null;
}

export interface BlackboardPutSuccess {
  ok: true;
  entry: BlackboardEntry;
}

export interface BlackboardConflict {
  ok: false;
  reason: "revision-conflict" | "read-only-namespace";
  currentRevision: number | null;
  currentValue: unknown | null;
  author: string | null;
  updatedAt: number | null;
}

export type BlackboardPutResult = BlackboardPutSuccess | BlackboardConflict;

export interface BlackboardDeleteSuccess {
  ok: true;
  deleted: boolean;
}

export type BlackboardDeleteResult = BlackboardDeleteSuccess | BlackboardConflict;

export interface SqliteStoreOptions {
  filePath: string;
  scopeKey: string;
  scopeMode: MessagingScopeMode;
  clock: () => number;
  messageBodyLimitBytes?: number;
  mailboxLimit?: number;
  messageTtlMs?: number;
  consumedRetentionMs?: number;
  blackboardValueLimitBytes?: number;
  blackboardKeysPerTopic?: number;
  heartbeatTimeoutMs?: number;
  maxHopCount?: number;
  operatorTopicPrefix?: string;
  isProcessAlive?: (pid: number) => boolean;
}

export interface MessagingCaller {
  agentId: string;
  sessionId: string;
  hopCount?: number;
}

export type DeliveryReceiptStatus = "accepted" | "injected" | "woken" | "queued" | "failed";

export interface DeliveryReceipt {
  messageId: string;
  toAgent: string;
  status: DeliveryReceiptStatus;
  surface?: "notice" | "body";
  reason?: string;
  correlationId?: string;
}

export interface ResolveTargetSuccess {
  ok: true;
  agent: AgentRow;
}

export interface ResolveTargetFailure {
  ok: false;
  reason: "not-found" | "ambiguous" | "nested-child";
  candidates?: string[];
}

export type ResolveTargetResult = ResolveTargetSuccess | ResolveTargetFailure;

/**
 * Bus traffic as it happens, for the human-facing surfaces only. Delivery does
 * not depend on anyone listening, and a listener never decides whether a
 * message is delivered — it only decides what a human is shown.
 */
export interface MessageActivity {
  type: "message";
  fromAgent: string;
  fromLabel: string;
  fromSession: string;
  /** Absent for a broadcast, which has no single recipient. */
  toAgent?: string;
  toLabel?: string;
  kind: MessageKind;
  body: string;
  /** Fan-out size of a broadcast. */
  recipients?: number;
  at: number;
}

export interface BoardActivity {
  type: "board";
  op: "put" | "delete";
  topic: string;
  key: string;
  /** The recorded author — a display name, which is what the board stores. */
  author: string;
  /** The writer's agent id, which is what identity checks use. */
  authorAgent: string;
  authorSession: string;
  revision?: number;
  value?: unknown;
  at: number;
}

export type MessagingActivity = MessageActivity | BoardActivity;
