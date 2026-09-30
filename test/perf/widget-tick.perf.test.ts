/**
 * widget-tick.perf.test.ts — the shape of the widget's animation tick, asserted
 * as operation counts rather than as time, for the same reasons its sibling
 * `render-invariants.perf.test.ts` does.
 *
 * A live CPU profile of pi showed this widget at the top of a full core: an
 * 80 ms interval armed on the first spawn and never disarmed, calling
 * `manager.listAgents()` and then `tui.requestRender()` 12.5 times a second for
 * the life of the process. Each of those requests re-renders the entire
 * conversation, so the cost is a whole frame per tick, forever, whether or not
 * anything on the widget changed — and the widget's own work (measured at
 * 0.001–0.007 ms per update) was never the point.
 *
 * So the invariant these pin is not "the tick is fast", it is "the tick exists
 * only while a row is actually animating". Everything the tick exists for — the
 * spinner frame and the elapsed/idle clocks — is state no event reports, which
 * is exactly why it must be a timer; and none of it is visible at any finer
 * than 100 ms, which is why it must not be faster.
 *
 * Bounds are upper bounds where a bound makes sense, so making any of this
 * cheaper must not turn a test red. `toBe(0)` where zero *is* the contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the interval pair is faked: `update()` reads no clock, and leaving
// setTimeout/Date real keeps the shared fixtures' timestamps honest.
beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));
afterEach(() => vi.useRealTimers());

const { AgentWidget } = await import("../../src/ui/agent-widget.js");
const { makeActivity, makeFleet, makeManager, perfTheme } = await import("../helpers/perf-fixtures.js");

/** A widget mounted the way index.ts mounts it, counting forced renders. */
function mount(records: unknown[]) {
  let renders = 0;
  let factory: any;
  const widget = new AgentWidget(
    makeManager(records),
    makeActivity(records as { id: string; toolUses: number }[]),
    () => "all",
    () => false,
    () => false,
  );
  widget.setUICtx({ setStatus: () => {}, setWidget: (_key: string, c: any) => { factory = c; } } as any);
  widget.update();
  // Production used to arm the tick here, explicitly, on every spawn. Calling
  // it when it exists keeps these guards honest: without it, "the widget never
  // ticks" passes trivially because nothing ever turned the tick on, and the
  // regression this file exists for slips back in unnoticed.
  (widget as any).ensureTimer?.();
  // Hand the widget a TUI so later updates take the requestRender() path
  // instead of re-registering — the production steady state.
  factory?.({ terminal: { columns: 120, rows: 40 }, requestRender: () => { renders++; } }, perfTheme);
  return { widget, renders: () => renders, reset: () => { renders = 0; } };
}

describe("AgentWidget — the animation tick only runs while something animates", () => {
  it.each([
    ["no agents", { running: 0, queued: 0, finished: 0 }],
    ["only finished agents lingering", { running: 0, queued: 0, finished: 3 }],
    ["only queued agents", { running: 0, queued: 3, finished: 0 }],
  ])("requests no renders on a timer with %s", (_label, fleet) => {
    const { widget, renders, reset } = mount(makeFleet(fleet));
    reset();
    vi.advanceTimersByTime(5_000);
    expect(renders()).toBe(0);
    widget.dispose();
  });

  it("animates a running row, and no faster than the tick has to be", () => {
    const { widget, renders, reset } = mount(makeFleet({ running: 3 }));
    reset();
    vi.advanceTimersByTime(1_000);
    // The spinner needs ten frames and the clocks render tenths of a second,
    // so 100 ms is the fastest tick that can change the picture. Allow a tick
    // of slack for the boundary, and demand it actually animates.
    expect(renders()).toBeGreaterThanOrEqual(1);
    expect(renders()).toBeLessThanOrEqual(11);
    widget.dispose();
  });

  it("stops ticking once the last running agent settles", () => {
    const records = makeFleet({ running: 1, finished: 2 });
    const { widget, renders, reset } = mount(records);
    for (const record of records) {
      if (record.status === "running") {
        record.status = "completed";
        record.completedAt = Date.now();
      }
      widget.markFinished(record.id);
    }
    widget.update();
    reset();
    vi.advanceTimersByTime(5_000);
    expect(renders()).toBe(0);
    widget.dispose();
  });

  it("stops ticking on dispose", () => {
    const { widget, renders, reset } = mount(makeFleet({ running: 3 }));
    widget.dispose();
    reset();
    vi.advanceTimersByTime(5_000);
    expect(renders()).toBe(0);
  });

  it("does not re-register or re-arm after dispose", () => {
    let registrations = 0;
    const records = makeFleet({ running: 1 });
    const widget = new AgentWidget(
      makeManager(records),
      makeActivity(records as { id: string; toolUses: number }[]),
      () => "all",
      () => false,
      () => false,
    );
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (key: string, c: any) => { if (key === "agents" && c) registrations++; },
    } as any);
    widget.update();
    expect(registrations).toBe(1);
    widget.dispose();
    widget.update(); // a completion that lands after teardown
    vi.advanceTimersByTime(5_000);
    expect(registrations).toBe(1);
  });
});

describe("AgentWidget — finished ages are bounded by the live roster", () => {
  it("evicts ages of agents that left the roster while the widget still has rows", () => {
    const records = makeFleet({ running: 1, finished: 3 });
    const { widget } = mount(records);
    const finished = records.filter(r => r.status === "completed");
    for (const record of finished) widget.markFinished(record.id);
    widget.update();
    const ages = (widget as any).finishedTurnAge as Map<string, number>;
    expect(ages.size).toBe(finished.length);

    // The manager GCs the records, and the widget still has a running row — so
    // it never empties, which is the case that used to skip eviction entirely.
    for (const record of finished) records.splice(records.indexOf(record), 1);
    widget.update();
    expect(ages.size).toBe(0);
    widget.dispose();
  });
});