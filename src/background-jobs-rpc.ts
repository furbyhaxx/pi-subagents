/**
 * background-jobs-rpc.ts — companion side of the pi-background-jobs event RPC.
 *
 * pi-subagents removes an ephemeral worktree after its agent settles. A job
 * started by that agent may still be running inside the tree, so cleanup stops
 * the worktree's jobs first, over the shared in-process `pi.events` bus (no
 * imports from the runtime package, no shared files):
 *
 *   request  background-jobs:rpc:ping           { requestId }
 *   reply    background-jobs:rpc:ping:reply:<id>           { success: true, data: { version: 1 } }
 *   request  background-jobs:rpc:stop-worktree  { requestId, path }
 *   reply    background-jobs:rpc:stop-worktree:reply:<id>  { success: true, data: { stopped: string[] } }
 *
 * The envelope is pi's standard `{ success: true, data? } | { success: false, error }`.
 *
 * The runtime also emits `background-jobs:ready`; this side does not listen for
 * it, because availability is probed with a ping on every call and never cached:
 * whether the runtime loaded before or after pi-subagents, was just reloaded, or
 * is absent altogether, the question "is a companion answering right now?" is
 * answered at the moment a worktree is cleaned up. There is nothing to go
 * permanently stale in either direction.
 *
 * The result is deliberately three-valued, because cleanup may only delete the
 * worktree when the answer is known:
 *  - `unavailable` — no companion ever answered the ping; there is nothing to
 *    stop here, so the caller proceeds (no-op).
 *  - `stopped` — the companion answered; `stopped` lists the job ids whose
 *    termination was confirmed (possibly empty).
 *  - `failed` — a companion answered the ping but the stop could not be
 *    confirmed (error, malformed reply, or timeout). Callers must retain the
 *    worktree and report the failure; deleting it would swallow live work.
 *
 * This file also owns the other direction: pi-background-jobs asks THIS
 * extension to run its shutdown cleanup before disposing its RPC responder
 * (Pi awaits `session_shutdown` handlers sequentially in load order, so a
 * provider loaded first would otherwise be gone before cleanup ran):
 *
 *   request   subagents:rpc:prepare-shutdown                    { requestId, version: 1, sessionId, reason, targetSessionFile? }
 *   accepted  subagents:rpc:prepare-shutdown:accepted:<id>      { version: 1, sessionId }
 *   reply     subagents:rpc:prepare-shutdown:reply:<id>         { success: true, data: { prepared: true } }
 *
 * Acceptance is emitted synchronously, before the first await: a requester
 * that sees none in the same tick must continue without waiting. The endpoint
 * is registered on `session_start`, bound to that session, and unsubscribed
 * when the cleanup it starts finishes.
 */

import { randomUUID } from "node:crypto";
import type { EventBus, RpcReply } from "./cross-extension-rpc.js";

/** How long a ping may take before the companion counts as unavailable. */
export const PING_TIMEOUT_MS = 2_000;

/** How long `stop-worktree` may take before termination counts as unconfirmed. */
export const STOP_TIMEOUT_MS = 10_000;

/** The only `background-jobs` protocol version this companion knows how to call. */
export const BACKGROUND_JOBS_PROTOCOL_VERSION = 1;

export type StopWorktreeResult =
  | { outcome: "unavailable" }
  | { outcome: "stopped"; stopped: string[] }
  | { outcome: "failed"; error: string };

type RpcOutcome<T> =
  | { kind: "data"; data: T | undefined }
  | { kind: "error"; error: string }
  | { kind: "timeout" };

/**
 * One request/reply round trip: emit on `channel`, wait for the per-request
 * scoped reply, give up after `timeoutMs`. Never rejects — the caller decides
 * what each failure means for cleanup.
 */
function request<T>(
  events: EventBus,
  channel: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<RpcOutcome<T>> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;
    const settle = (outcome: RpcOutcome<T>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsub?.();
      resolve(outcome);
    };
    timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
    timer.unref?.();
    unsub = events.on(`${channel}:reply:${requestId}`, (raw) => {
      const reply = raw as RpcReply<T> | undefined;
      if (reply?.success === true) {
        settle({ kind: "data", data: reply.data });
      } else {
        settle({
          kind: "error",
          error: typeof reply?.error === "string" && reply.error ? reply.error : "malformed RPC reply",
        });
      }
    });
    events.emit(channel, { requestId, ...params });
  });
}

/**
 * Stop every background job whose canonical worktree is `path`.
 *
 * `events` is `pi.events`; a host without one (bare test doubles, programmatic
 * contexts) has no companion and resolves `unavailable` immediately.
 */
export async function stopWorktreeJobs(
  events: EventBus | undefined,
  path: string,
  timeouts: { pingMs?: number; stopMs?: number } = {},
): Promise<StopWorktreeResult> {
  if (!events) return { outcome: "unavailable" };

  const ping = await request<{ version?: number }>(
    events,
    "background-jobs:rpc:ping",
    {},
    timeouts.pingMs ?? PING_TIMEOUT_MS,
  );
  if (ping.kind === "timeout") return { outcome: "unavailable" };
  if (ping.kind === "error") return { outcome: "failed", error: `background-jobs ping failed: ${ping.error}` };
  if (ping.data?.version !== BACKGROUND_JOBS_PROTOCOL_VERSION) {
    // A mismatched protocol means the stop reply cannot be trusted, and an
    // unconfirmed stop must never be followed by deletion.
    return {
      outcome: "failed",
      error: `background-jobs protocol version ${String(ping.data?.version)} is not supported (expected ${BACKGROUND_JOBS_PROTOCOL_VERSION})`,
    };
  }

  const stopMs = timeouts.stopMs ?? STOP_TIMEOUT_MS;
  const stop = await request<{ stopped?: string[] }>(
    events,
    "background-jobs:rpc:stop-worktree",
    { path },
    stopMs,
  );
  if (stop.kind === "timeout") {
    return { outcome: "failed", error: `background-jobs stop-worktree timed out after ${stopMs}ms` };
  }
  if (stop.kind === "error") {
    return { outcome: "failed", error: `background-jobs stop-worktree failed: ${stop.error}` };
  }
  const stopped = stop.data?.stopped;
  if (!Array.isArray(stopped) || stopped.some((id) => typeof id !== "string")) {
    return { outcome: "failed", error: "background-jobs stop-worktree returned a malformed reply" };
  }
  return { outcome: "stopped", stopped };
}

/** The only prepare-shutdown protocol version this companion answers. */
export const PREPARE_SHUTDOWN_PROTOCOL_VERSION = 1;

/** The channel pi-background-jobs sends its shutdown preparation request on. */
export const PREPARE_SHUTDOWN_CHANNEL = "subagents:rpc:prepare-shutdown";

const SHUTDOWN_REASONS = new Set(["quit", "reload", "new", "resume", "fork"]);

export interface PrepareShutdownEndpointDeps {
  events: EventBus;
  /** The session this activation is bound to; undefined before `session_start`. */
  getSessionId: () => string | undefined;
  /** The activation's memoized shutdown cleanup. Duplicate requests join it. */
  runShutdown: () => Promise<void>;
}

/**
 * Register the `prepare-shutdown` endpoint on the shared bus and return its
 * unsubscribe function.
 *
 * The handler validates the request and ignores everything that is not a
 * matching, well-formed request for this activation's bound session: a child or
 * independent activation must not be able to start the root manager's shutdown,
 * and the requester's fallback for "no acceptance" is safe by construction.
 * Acceptance goes out before the first await; the completion reply resolves the
 * request once the cleanup finishes. Duplicate valid requests join the same
 * memoized cleanup but each gets its own scoped reply.
 */
export function registerPrepareShutdownEndpoint(deps: PrepareShutdownEndpointDeps): () => void {
  const emit = (channel: string, data: unknown): void => {
    try {
      deps.events.emit(channel, data);
    } catch (error) {
      // The host is tearing down; a reply that cannot be delivered must not
      // abort the cleanup it is reporting on.
      console.warn("[pi-subagents] prepare-shutdown reply emission failed:", error);
    }
  };

  return deps.events.on(PREPARE_SHUTDOWN_CHANNEL, (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const request = raw as {
      requestId?: unknown;
      version?: unknown;
      sessionId?: unknown;
      reason?: unknown;
      targetSessionFile?: unknown;
    };
    const boundSessionId = deps.getSessionId();
    if (!boundSessionId) return;
    if (typeof request.requestId !== "string" || !request.requestId) return;
    if (request.version !== PREPARE_SHUTDOWN_PROTOCOL_VERSION) return;
    if (request.sessionId !== boundSessionId) return;
    if (typeof request.reason !== "string" || !SHUTDOWN_REASONS.has(request.reason)) return;
    if (request.targetSessionFile !== undefined && typeof request.targetSessionFile !== "string") {
      return;
    }
    const requestId = request.requestId;

    // Synchronous, before the first await: acceptance means "cleanup starts
    // now", never "cleanup is done". A requester that sees no acceptance in
    // this same tick proceeds with its own teardown instead of waiting.
    emit(`${PREPARE_SHUTDOWN_CHANNEL}:accepted:${requestId}`, {
      version: PREPARE_SHUTDOWN_PROTOCOL_VERSION,
      sessionId: boundSessionId,
    });

    let cleanup: Promise<void>;
    try {
      cleanup = deps.runShutdown();
    } catch (error) {
      emit(`${PREPARE_SHUTDOWN_CHANNEL}:reply:${requestId}`, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    void cleanup.then(
      () =>
        emit(`${PREPARE_SHUTDOWN_CHANNEL}:reply:${requestId}`, {
          success: true,
          data: { prepared: true },
        }),
      (error: unknown) =>
        emit(`${PREPARE_SHUTDOWN_CHANNEL}:reply:${requestId}`, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  });
}
