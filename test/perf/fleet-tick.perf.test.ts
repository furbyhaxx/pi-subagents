/**
 * fleet-tick.perf.test.ts — the shape of the fleet list's refresh tick, for the
 * same reasons and in the same style as its sibling `widget-tick.perf.test.ts`.
 *
 * The list ran a 200 ms interval that re-armed itself from `update()` whenever
 * the roster was non-empty, so it never idled: five re-renders a second for the
 * whole life of any session that had ever spawned an agent, each one a full
 * conversation re-render triggered by a row that was not moving.
 *
 * The tick earns its keep in exactly two places, and neither reports itself as
 * an event: the elapsed clock on a live row, and the wall-clock expiry of a
 * settled row's 4 s linger — nothing fires at t+4000 ms, so that row only leaves
 * the list because something re-reads it. A queued row's clock does not run and
 * its transition to running arrives as an ordinary update, so it is deliberately
 * not a reason to tick.
 *
 * Upper bounds where a bound makes sense, so making any of this cheaper must not
 * turn a test red. `toBe(0)` where zero is the contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));
afterEach(() => vi.useRealTimers());

const { FleetList } = await import("../../src/ui/fleet-list.js");
const { makeFleet, makeManager, perfTheme } = await import("../helpers/perf-fixtures.js");

const FAKE_SESSION = { subscribe: () => () => {}, messages: [] };

/** A list shown the way index.ts shows it, counting forced renders. */
function mount(records: unknown[]) {
  let renders = 0;
  let factory: any;
  const list = new FleetList(makeManager(records), new Map());
  list.setUICtx({
    setWidget: (_key: string, component: any) => { factory = component; },
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    notify: () => {},
    custom: () => new Promise<undefined>(() => {}),
  } as any);
  list.update();
  factory?.({ terminal: { columns: 120, rows: 40 }, requestRender: () => { renders++; } }, perfTheme);
  return { list, renders: () => renders, reset: () => { renders = 0; } };
}

describe("FleetList — the tick only runs while a row is moving", () => {
  it("requests no renders on a timer with only queued agents", () => {
    const { list, renders, reset } = mount(makeFleet({ running: 0, queued: 3, finished: 0 }));
    reset();
    vi.advanceTimersByTime(5_000);
    expect(renders()).toBe(0);
    list.dispose();
  });

  it("animates a running row", () => {
    const { list, renders, reset } = mount(makeFleet({ running: 2, queued: 0, finished: 0 }));
    reset();
    vi.advanceTimersByTime(1_000);
    expect(renders()).toBeGreaterThan(0);
    list.dispose();
  });

  it("keeps ticking while a settled row is inside its linger window", () => {
    const settled = Date.now() - 1_000;
    const { list, renders, reset } = mount([
      { id: "a1", type: "general-purpose", description: "done", status: "stopped", toolUses: 1, startedAt: settled - 5_000, completedAt: settled, session: FAKE_SESSION },
    ]);
    reset();
    vi.advanceTimersByTime(1_000);
    expect(renders()).toBeGreaterThan(0);
    list.dispose();
  });

  it("stops once the last animated row is gone", () => {
    // A run that settled over 4 s ago: still listed, but nothing about it moves.
    const old = Date.now() - 10_000;
    const { list, renders, reset } = mount([
      { id: "a1", type: "general-purpose", description: "done", status: "stopped", toolUses: 1, startedAt: old - 5_000, completedAt: old, session: FAKE_SESSION },
    ]);
    reset();
    vi.advanceTimersByTime(5_000);
    expect(renders()).toBe(0);
    list.dispose();
  });

  it("stops ticking after dispose", () => {
    const { list, renders, reset } = mount(makeFleet({ running: 2, queued: 0, finished: 0 }));
    list.dispose();
    reset();
    vi.advanceTimersByTime(5_000);
    expect(renders()).toBe(0);
  });

  it("resumes ticking when a queued agent starts", () => {
    const agents: any[] = [{
      id: "a1", type: "general-purpose", description: "wait", status: "queued",
      toolUses: 0, startedAt: Date.now(), session: FAKE_SESSION,
    }];
    const { list, renders, reset } = mount(agents);
    reset();
    vi.advanceTimersByTime(1_000);
    expect(renders()).toBe(0);

    agents[0] = { ...agents[0], status: "running" };
    list.update();
    reset();
    vi.advanceTimersByTime(1_000);
    expect(renders()).toBeGreaterThan(0);
    list.dispose();
  });
});
