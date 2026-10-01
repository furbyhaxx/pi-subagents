/**
 * result-wait.ts — shared wait for a background agent's result.
 *
 * `get_subagent_result(wait: true)` blocks until the agent settles. Anything the
 * operator types during that block is queued by pi as a steering message or a
 * follow-up and is not delivered until the tool returns, so a long wait holds a
 * prompt hostage. This waits for the agent OR for queued input, whichever lands
 * first.
 *
 * Releasing on input ends the wait and nothing else: the child keeps running, its
 * result is not marked consumed, and its completion notification is still
 * delivered. No input hook, no `ctx.abort`, no child cancellation. Esc still
 * rejects the call with the signal's own reason, exactly as `abortable` does.
 */

import { abortable } from "./abortable.js";
import type { AgentRecord } from "./types.js";

/** 50ms — short enough that the release feels immediate, long enough not to spin. */
const POLL_MS = 50;

/** `settled`: the agent finished. `pending-input`: the operator typed instead. */
export type ResultWaitOutcome = "settled" | "pending-input";

/** A POLL_MS sleep that drops its timer the moment the caller cancels. */
function tick(signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slept = new Promise<void>((resolve) => { timer = setTimeout(resolve, POLL_MS); });
  return abortable(slept, signal).finally(() => clearTimeout(timer));
}

/**
 * Block until `record` leaves `queued`/`running`, or until `hasPendingMessages()`
 * reports input waiting. The polling timer exists only for the duration of an
 * active wait and is cleared on every exit path.
 *
 * `hasPendingMessages` is read once up front and then on every tick, so input
 * that was already waiting — or arrives mid-wait — releases on the same path.
 * Each caller passes its own execution context's reader, so a nested wait reads
 * the child session's queue rather than the root's.
 */
export async function waitForResult(
  record: Pick<AgentRecord, "status" | "promise">,
  hasPendingMessages: () => boolean,
  signal?: AbortSignal,
): Promise<ResultWaitOutcome> {
  if (record.status !== "queued" && record.status !== "running") return "settled";
  if (signal?.aborted) throw signal.reason;

  // Observed only to learn when the run settled. A rejection landing after the
  // wait released has no caller left, and an unobserved one takes the process down.
  record.promise?.catch(() => {});
  if (hasPendingMessages()) return "pending-input";

  let release = () => {};
  const typed = new Promise<void>((resolve) => { release = resolve; });
  let pending = false;
  const poll = setInterval(() => {
    if (hasPendingMessages()) { pending = true; release(); }
  }, POLL_MS);

  try {
    // A queued record has no promise yet — the manager creates one when the queue
    // starts it — so the record's own status carries the wait until then.
    while (record.status === "queued") {
      await Promise.race([typed, tick(signal)]);
      if (pending) break;
    }
    if (!pending && record.promise) await Promise.race([typed, abortable(record.promise, signal)]);
    return pending ? "pending-input" : "settled";
  } finally {
    clearInterval(poll);
  }
}

/**
 * The note both result tools show when a wait was released by typed input rather
 * than by the agent finishing. Names the agent and its live state so the caller
 * does not read the return as a verdict on the run.
 */
export function pendingInputNote(record: Pick<AgentRecord, "id" | "status">): string {
  return (
    `Wait interrupted by queued user input. Only this wait ended: agent ${record.id} is still ${record.status} `
    + `and keeps running in the background, and its completion notification will still arrive. `
    + `Call get_subagent_result again to collect it.`
  );
}
