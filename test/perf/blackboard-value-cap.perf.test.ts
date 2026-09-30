/**
 * blackboard-value-cap.perf.test.ts — the bound on what one blackboard value may
 * cost the render path.
 *
 * A value is arbitrary JSON: anything non-string goes through
 * `JSON.stringify(value, null, 2)`, so its size is not bounded by construction.
 * Both the detail pane and the value pane wrapped the whole thing on every
 * frame and on every keypress, and the detail pane sliced to 200 lines
 * *afterwards* — so the wrap cost was paid in full and then thrown away, in a
 * pane a few dozen rows tall. In a session where an agent writes a large
 * progress blob, that is a full-conversation re-render's worth of string work
 * per keystroke, on a widget that is redrawn by everything else in the
 * extension.
 *
 * The invariant pinned here is the cap itself: a short value still renders in
 * full, and a long one is cut so the tail is never wrapped or drawn — which is
 * what bounds the work. `toBe(0)` where zero is the contract.
 */
import { describe, expect, it, vi } from "vitest";
import type { BlackboardEntry, BlackboardPanelInitial } from "../../src/messaging/blackboard-types.js";
import { BlackboardPanel } from "../../src/ui/blackboard-panel.js";
import type { MessagingPanelTui } from "../../src/ui/messaging-panels.js";

const MAX_VALUE_LINES = 200;

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const info = {
  scopeKey: "project:test",
  scopeMode: "project" as const,
  databasePath: "/tmp/project-test/messaging.sqlite3",
  operatorTopicPrefix: "operator/",
  sessionId: "session-own",
  transport: "socket" as const,
};

function entry(over: Partial<BlackboardEntry> = {}): BlackboardEntry {
  return {
    topic: "operator/constraints",
    key: "policy",
    value: { deny: true },
    author: "operator",
    authorAgentId: null,
    authorSessionId: info.sessionId,
    entryToken: 7,
    revision: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    expiresAt: null,
    ...over,
  } as BlackboardEntry;
}

function mount(value: unknown) {
  const initial: BlackboardPanelInitial = { entries: [entry({ value })], info };
  const service = {
    setEntries: vi.fn(),
    boardList: vi.fn(() => initial.entries),
    boardRecentLog: vi.fn(() => []),
    getPanelInfo: vi.fn(() => info),
    operatorPut: vi.fn(),
    operatorDelete: vi.fn(),
    operatorExpire: vi.fn(),
  };
  const tui: MessagingPanelTui & { renders: number } = {
    terminal: { rows: 400 },
    renders: 0,
    requestRender() { this.renders++; },
  };
  const panel = new BlackboardPanel(tui, theme, vi.fn(), service as any, { custom: vi.fn(), input: vi.fn(), editor: vi.fn(), select: vi.fn(), notify: vi.fn() } as any, initial);
  return { panel, tui };
}

/** Drill to the key detail pane, and (optionally) on to the full-value pane. */
function openValue(panel: BlackboardPanel, full: boolean) {
  panel.handleInput("\r"); // topics → keys
  panel.handleInput("\r"); // keys → detail
  if (full) panel.handleInput("o"); // detail → full value
}

/**
 * The rendered text of a pane scrolled to its end.
 *
 * The panel splits topics and detail side by side, so the value body is only a
 * dozen rows tall — the cap notice sits below the fold until you scroll to it.
 */
function scrolledToEnd(panel: BlackboardPanel): string {
  panel.handleInput("G"); // first / last
  return panel.render(80).join("\n");
}

describe("Blackboard value rendering is bounded by the line cap, not the value", () => {
  it("keeps a short value whole in the detail pane", () => {
    const { panel } = mount({ note: "hello" });
    openValue(panel, false);
    const rendered = panel.render(80).join("\n");
    expect(rendered).toContain("hello");
    expect(rendered).not.toContain("truncated");
    panel.dispose();
  });

  it("caps a huge value in the detail pane and says so", () => {
    // 5 000 lines of JSON — far past any viewport, and exactly the shape of an
    // agent writing a large progress blob.
    const huge = Array.from({ length: 5_000 }, (_, i) => `  "k${i}": "v${i}"`).join(",\n");
    const { panel } = mount(JSON.parse(`{\n${huge}\n}`));
    openValue(panel, false);
    const rendered = scrolledToEnd(panel);
    expect(rendered).toContain("truncated");
    expect(rendered).toContain("Press o for the full value");
    panel.dispose();
  });

  it("caps the full-value pane too, rather than wrapping an unbounded value", () => {
    const huge = Array.from({ length: 5_000 }, (_, i) => `  "k${i}": "v${i}"`).join(",\n");
    const { panel } = mount(JSON.parse(`{\n${huge}\n}`));
    openValue(panel, true);
    const rendered = scrolledToEnd(panel);
    expect(rendered).toContain(`truncated at ${MAX_VALUE_LINES} lines`);
    // The tail of the value must not be present: that is what the cap buys.
    expect(rendered).not.toContain("k4999");
    panel.dispose();
  });
});
