import type { AgentRecord } from "./types.js";

/** 50ms — short enough that the release feels immediate, long enough not to spin. */
const POLL_MS = 50;

/** `settled`: the agent finished. `pending-input`: the operator typed instead. */
export type ResultWaitOutcome = "settled" | "pending-input";

/**
 * Wait for `record` to finish or for `hasPendingMessages()` to report queued
 * input, whichever lands first. Neither release touches the agent: no abort,
 * no cancellation, nothing marked consumed.
 */
export async function waitForResult(
  record: Pick<AgentRecord, "status" | "promise">,
  hasPendingMessages: () => boolean,
  signal?: AbortSignal,
): Promise<ResultWaitOutcome> {
  if (record.status !== "queued" && record.status !== "running") return "settled";
  if (signal?.aborted) throw signal.reason;

  let settle: (outcome: ResultWaitOutcome) => void = () => {};
  let fail: (reason: unknown) => void = () => {};
  const wait = new Promise<ResultWaitOutcome>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // A child rejection landing after the release has no caller left, and an
  // unhandled one takes the process down. Callers still see it via `await wait`.
  wait.catch(() => {});

  let observed: Promise<string> | undefined;
  const observe = () => {
    const child = record.promise;
    if (!child || child === observed) return;
    observed = child;
    child.then(() => settle("settled"), (error: unknown) => fail(error));
  };

  const check = () => {
    if (hasPendingMessages()) settle("pending-input");
    else if (record.promise) observe();
    // A queued agent only gets its promise once the manager starts it.
    else if (record.status !== "queued" && record.status !== "running") settle("settled");
  };

  let poll: ReturnType<typeof setInterval> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    observe();
    if (hasPendingMessages()) return "pending-input";
    if (signal) {
      onAbort = () => fail(signal.reason);
      signal.addEventListener("abort", onAbort);
    }
    poll = setInterval(check, POLL_MS);
    return await wait;
  } finally {
    if (poll !== undefined) clearInterval(poll);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** The note both result tools show when typed input, not the agent, ended a wait. */
export function pendingInputNote(record: Pick<AgentRecord, "id" | "status">): string {
  return (
    `Wait interrupted by queued user input. Only this wait ended: agent ${record.id} is still ${record.status} `
    + `and keeps running in the background, and its completion notification will still arrive. `
    + `Respond to the queued message before waiting again. `
    + `Call get_subagent_result again to collect it.`
  );
}
