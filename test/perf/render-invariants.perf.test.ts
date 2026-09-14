/**
 * render-invariants.perf.test.ts — the shape of the render paths, asserted as
 * operation counts rather than as time.
 *
 * These run in the normal suite, which means they run three times per CI push
 * (build, floor-Pi, latest-Pi) on shared runners. A wall-clock threshold there
 * would be a flake generator: two runs of identical code in this repo differed
 * by 7% on ordering alone. So nothing here is timed. Counting how many times a
 * render reaches a leaf is deterministic, costs milliseconds, and catches the
 * regression that actually hurts — work that stops being linear, or a frame
 * that starts touching the disk.
 *
 * Absolute numbers live in `test/perf/*.bench.ts`, where a human reads them.
 *
 * Every bound here is an upper bound, never an equality: making one of these
 * paths cheaper must not turn a test red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Counters for the pi-tui leaves the viewer wraps its text with. */
const counts = { wrap: 0, markdownNew: 0, markdownRender: 0 };

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  class CountingMarkdown extends (actual.Markdown as any) {
    constructor(...args: any[]) {
      super(...args);
      counts.markdownNew++;
    }
    render(...args: any[]) {
      counts.markdownRender++;
      return super.render(...args);
    }
  }
  return {
    ...actual,
    Markdown: CountingMarkdown,
    wrapTextWithAnsi: (...args: [string, number]) => {
      counts.wrap++;
      return actual.wrapTextWithAnsi(...args);
    },
  };
});

// After the mock, so the subjects bind the counting versions.
const { AgentWidget } = await import("../../src/ui/agent-widget.js");
const { ConversationViewer } = await import("../../src/ui/conversation-viewer.js");
const { makeActivity, makeFleet, makeSession, mountViewer, perfTheme, perfTui } = await import(
  "../helpers/perf-fixtures.js"
);

beforeEach(() => {
  counts.wrap = 0;
  counts.markdownNew = 0;
  counts.markdownRender = 0;
});

describe("ConversationViewer — viewport-bounded transcript work", () => {
  function warmLeafCalls(n: number, view: "steps" | "raw"): number {
    const viewer = mountViewer(ConversationViewer, makeSession(n), undefined, () => "assistant", () => view);
    viewer.render(120);
    counts.wrap = 0;
    counts.markdownRender = 0;
    viewer.render(120);
    return counts.wrap + counts.markdownRender;
  }

  it("does no transcript wrapping on a warm collapsed Steps frame", () => {
    expect(warmLeafCalls(50, "steps")).toBe(0);
    expect(warmLeafCalls(5000, "steps")).toBe(0);
  });

  it("reuses cached Raw blocks on an unchanged frame", () => {
    expect(warmLeafCalls(50, "raw")).toBe(0);
    expect(warmLeafCalls(500, "raw")).toBe(0);
  });

  it("touches only the changed live block for one Steps delta", () => {
    const session = makeSession(500);
    const viewer = mountViewer(ConversationViewer, session, undefined, () => "assistant", () => "steps");
    viewer.render(120);
    counts.wrap = 0;
    counts.markdownRender = 0;
    const message = session.messages.findLast((candidate: any) => candidate.role === "assistant");
    message.content[0].text += " live delta";
    session.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: " live delta" } });
    viewer.render(120);
    expect(counts.wrap + counts.markdownRender).toBeLessThanOrEqual(2);
  });

  it("reformats only the changed cached Raw block for one delta", () => {
    const session = makeSession(500);
    const viewer = mountViewer(ConversationViewer, session, undefined, () => "assistant", () => "raw");
    viewer.render(120);
    counts.wrap = 0;
    counts.markdownRender = 0;
    const message = session.messages.findLast((candidate: any) => candidate.role === "assistant");
    message.content[0].text += " live delta";
    session.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: " live delta" } });
    viewer.render(120);
    expect(counts.wrap + counts.markdownRender).toBeLessThanOrEqual(2);
  });
});

describe("AgentWidget — one frame does not rescan per agent", () => {
  /** Renders one frame over `n` agents; returns how often the manager was asked. */
  function listCallsPerRender(n: number): number {
    const records = makeFleet({ running: n });
    let listAgentsCalls = 0;
    const manager = {
      listAgents: () => {
        listAgentsCalls++;
        return records;
      },
    } as any;

    const widget = new AgentWidget(manager, makeActivity(records), () => "all", () => false, () => false);
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: string, c: any) => { factory = c; } } as any);
    widget.update();
    const tui = perfTui();
    factory?.(tui, perfTheme).render(); // prime
    listAgentsCalls = 0;
    factory?.(tui, perfTheme).render();
    widget.dispose?.();
    return listAgentsCalls;
  }

  // Today a render is exactly one scan (`update()` does the other). The bound is
  // "a constant, and the same constant at 100 agents as at 1" — a per-agent
  // lookup added to the row builder would break it, and collapsing the two
  // remaining scans into one would not.
  it("asks the manager for the agent list a constant number of times", () => {
    expect(listCallsPerRender(1)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBe(listCallsPerRender(1));
  });
});
