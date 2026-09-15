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
