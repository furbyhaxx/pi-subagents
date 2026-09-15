/**
 * background-jobs-rpc.test.ts — the pi-subagents side of `background-jobs:rpc`.
 *
 * The runtime package is implemented separately, so the "companion" here is a
 * contract fixture: handlers on a test bus that speak the version-1 envelope
 * (`ping` → `{ version: 1 }`, `stop-worktree` → `{ stopped: string[] }`) exactly
 * as docs/rpc.md pins it. There are deliberately no imports from
 * pi-background-jobs — the coupling is the documented envelope, nothing else.
 *
 * The three cleanup outcomes are the point of the suite: `unavailable` (no
 * companion answered the ping — cleanup proceeds), `stopped` (termination
 * confirmed), and `failed` (a companion was there but termination was not
 * confirmed — the caller must retain the worktree).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_JOBS_PROTOCOL_VERSION,
  PING_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  stopWorktreeJobs,
} from "../src/background-jobs-rpc.js";
import { createTestEventBus, type TestEventBus } from "./helpers/event-bus.js";

const PING = "background-jobs:rpc:ping";
const STOP = "background-jobs:rpc:stop-worktree";

/** Reply on the request's scoped reply channel, as the runtime does. */
function reply(bus: TestEventBus, channel: string, requestId: string, envelope: unknown): void {
  bus.emit(`${channel}:reply:${requestId}`, envelope);
}

/** Request-side emits only — the same bus also carries the companion's replies. */
function requestChannels(bus: TestEventBus): string[] {
  return bus.emitted.filter((entry) => !entry.channel.includes(":reply:")).map((entry) => entry.channel);
}

/**
 * A version-1 companion. Every handler is overridable so a test can make the
 * ping or the stop answer with an error, malform its reply, or stay silent.
 */
function installCompanion(
  bus: TestEventBus,
  handlers: {
    ping?: (requestId: string) => void;
    stop?: (requestId: string, path: string) => void;
  } = {},
): void {
  bus.on(PING, (raw) => {
    const { requestId } = raw as { requestId: string };
    handlers.ping?.(requestId);
  });
  bus.on(STOP, (raw) => {
    const { requestId, path } = raw as { requestId: string; path: string };
    handlers.stop?.(requestId, path);
  });
}

/** A companion that answers both calls successfully. */
function answeringCompanion(bus: TestEventBus, stopped: string[] = []): { stops: { requestId: string; path: string }[] } {
  const stops: { requestId: string; path: string }[] = [];
  installCompanion(bus, {
    ping: (requestId) => reply(bus, PING, requestId, {
      success: true,
      data: { version: BACKGROUND_JOBS_PROTOCOL_VERSION },
    }),
    stop: (requestId, path) => {
      stops.push({ requestId, path });
      reply(bus, STOP, requestId, { success: true, data: { stopped } });
    },
  });
  return { stops };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stopWorktreeJobs — successful round trip", () => {
  it("pings first, then stops the worktree and returns the confirmed job ids", async () => {
    const bus = createTestEventBus();
    const companion = answeringCompanion(bus, ["job-0000aaaa", "job-0000bbbb"]);

    await expect(stopWorktreeJobs(bus, "/repo/wt")).resolves.toEqual({
      outcome: "stopped",
      stopped: ["job-0000aaaa", "job-0000bbbb"],
    });

    // Ping before stop: availability decides whether the stop is even sent.
    expect(requestChannels(bus)).toEqual([PING, STOP]);
    expect(companion.stops).toEqual([{ requestId: expect.any(String), path: "/repo/wt" }]);
    // Both requestIds are distinct and the stop payload carries the path.
    expect(bus.emitted[0].data.requestId).not.toBe(bus.emitted[1].data.requestId);
  });

  it("cleans up the scoped reply subscriptions after each request", async () => {
    const bus = createTestEventBus();
    answeringCompanion(bus);

    await stopWorktreeJobs(bus, "/wt");

    for (const entry of bus.emitted) {
      expect(bus.listenerCount(`${entry.channel}:reply:${String(entry.data.requestId)}`)).toBe(0);
    }
  });

  it("scopes concurrent requests to their own replies", async () => {
    const bus = createTestEventBus();
    installCompanion(bus, {
      ping: (requestId) => reply(bus, PING, requestId, { success: true, data: { version: 1 } }),
      stop: (requestId, path) => {
        reply(bus, STOP, requestId, { success: true, data: { stopped: [path === "/a" ? "job-a" : "job-b"] } });
      },
    });

    const [a, b] = await Promise.all([stopWorktreeJobs(bus, "/a"), stopWorktreeJobs(bus, "/b")]);
    expect(a).toEqual({ outcome: "stopped", stopped: ["job-a"] });
    expect(b).toEqual({ outcome: "stopped", stopped: ["job-b"] });
  });
});

describe("stopWorktreeJobs — unavailability is a no-op", () => {
  it("treats a missing event bus as unavailable without waiting", async () => {
    await expect(stopWorktreeJobs(undefined, "/wt")).resolves.toEqual({ outcome: "unavailable" });
  });

  it("treats a companion that never answers the ping as unavailable", async () => {
    vi.useFakeTimers();
    const bus = createTestEventBus();

    const pending = stopWorktreeJobs(bus, "/wt");
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ outcome: "unavailable" });

    // The probe is bounded: nothing is left armed after it gives up.
    expect(vi.getTimerCount()).toBe(0);
    expect(requestChannels(bus)).toEqual([PING]);
  });

  it("finds a companion loaded after an earlier probe failed (nothing is cached)", async () => {
    // Load order / reload robustness: a probe that found nobody must not be
    // remembered as "never available". The runtime package can be loaded after
    // pi-subagents, or re-register its handlers after a reload.
    vi.useFakeTimers();
    const bus = createTestEventBus();
    const first = stopWorktreeJobs(bus, "/wt");
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await expect(first).resolves.toEqual({ outcome: "unavailable" });
    vi.useRealTimers();

    answeringCompanion(bus, ["job-late"]);
    await expect(stopWorktreeJobs(bus, "/wt")).resolves.toEqual({
      outcome: "stopped",
      stopped: ["job-late"],
    });
  });
});

describe("stopWorktreeJobs — a present companion always answers for itself", () => {
  it("fails (never deletes) when the ping replies with an error", async () => {
    const bus = createTestEventBus();
    installCompanion(bus, {
      ping: (requestId) => reply(bus, PING, requestId, { success: false, error: "handler exploded" }),
    });

    const result = await stopWorktreeJobs(bus, "/wt");
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.outcome === "failed" && result.error).toContain("handler exploded");
    expect(requestChannels(bus)).toEqual([PING]);
  });

  it("fails when the ping reply reports no version", async () => {
    const bus = createTestEventBus();
    installCompanion(bus, { ping: (requestId) => reply(bus, PING, requestId, { success: true }) });

    const result = await stopWorktreeJobs(bus, "/wt");
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.outcome === "failed" && result.error).toContain("version undefined");
  });

  it("fails on a protocol version it does not know", async () => {
    const bus = createTestEventBus();
    installCompanion(bus, {
      ping: (requestId) => reply(bus, PING, requestId, { success: true, data: { version: 2 } }),
      stop: () => { throw new Error("stop must not be sent to an unsupported version"); },
    });

    const result = await stopWorktreeJobs(bus, "/wt");
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.outcome === "failed" && result.error).toContain("version 2");
  });

  it("fails when the stop replies with an error", async () => {
    const bus = createTestEventBus();
    installCompanion(bus, {
      ping: (requestId) => reply(bus, PING, requestId, { success: true, data: { version: 1 } }),
      stop: (requestId) => reply(bus, STOP, requestId, { success: false, error: "cannot signal pid" }),
    });

    const result = await stopWorktreeJobs(bus, "/wt");
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.outcome === "failed" && result.error).toContain("cannot signal pid");
  });

  it("fails when the stop times out", async () => {
    vi.useFakeTimers();
    const bus = createTestEventBus();
    installCompanion(bus, {
      ping: (requestId) => reply(bus, PING, requestId, { success: true, data: { version: 1 } }),
      stop: () => { /* stay silent */ },
    });

    const pending = stopWorktreeJobs(bus, "/wt");
    await vi.advanceTimersByTimeAsync(0); // let the ping reply reach the client
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    const result = await pending;
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.outcome === "failed" && result.error).toContain(`timed out after ${STOP_TIMEOUT_MS}ms`);
  });

  it("fails on a malformed stop reply instead of assuming no jobs", async () => {
    const bus = createTestEventBus();
    installCompanion(bus, {
      ping: (requestId) => reply(bus, PING, requestId, { success: true, data: { version: 1 } }),
      stop: (requestId) => reply(bus, STOP, requestId, { success: true, data: { stopped: "job-1" } }),
    });

    await expect(stopWorktreeJobs(bus, "/wt")).resolves.toEqual({
      outcome: "failed",
      error: "background-jobs stop-worktree returned a malformed reply",
    });
  });

  it("fails rather than deletion when the reply is not an envelope at all", async () => {
    const bus = createTestEventBus();
    installCompanion(bus, {
      ping: (requestId) => reply(bus, PING, requestId, null),
    });

    const result = await stopWorktreeJobs(bus, "/wt");
    expect(result).toMatchObject({ outcome: "failed" });
  });
});
