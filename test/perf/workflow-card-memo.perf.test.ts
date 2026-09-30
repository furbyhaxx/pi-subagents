/**
 * workflow-card-memo.perf.test.ts — a workflow tool result stays in scrollback
 * for the rest of the session and is re-laid-out on every conversation frame.
 *
 * Each layout is O(progress entries) and re-runs a width clamp per line, so a
 * session with many workflow calls pays that on every keystroke and on every
 * other widget's tick, growing without bound. The card is memoised on the
 * progress array it was built from plus the rest of its inputs, and the point
 * of these guards is that the memo is *sound*: it must hit for a settled card
 * across arbitrary wall-clock movement (that is the scrollback case, and the
 * whole reason the clock is dropped from the key once a run has settled), and
 * it must miss the moment any input that feeds the layout actually moves.
 *
 * Instance identity is the assertion, not deep equality: reusing the array is
 * what makes the hit free, and the callers only ever read the lines.
 */
import { describe, expect, it } from "vitest";

import { layoutWorkflowCard, type WorkflowCardInput, type WorkflowCardTask } from "../../src/ui/workflow-card.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "../../src/workflow/progress.js";

const START = 1_000_000;

function agentEntry(index: number, over: Partial<WorkflowAgentEntry> = {}): WorkflowAgentEntry {
  return {
    type: "workflow_agent",
    label: `agent-${index}`,
    phaseIndex: 0,
    state: "done",
    ...over,
  } as WorkflowAgentEntry;
}

function settledTask(over: Partial<WorkflowCardTask> = {}): WorkflowCardTask {
  return { status: "completed", workflowName: "review-changes", startTime: START, endTime: START + 5_000, ...over };
}

/** The live, append-only array the runtime hands to the card. */
function liveProgress(entries: WorkflowEntry[]): WorkflowEntry[] {
  return entries;
}

function input(over: Partial<WorkflowCardInput> = {}): WorkflowCardInput {
  return { width: 120, task: settledTask(), ...over };
}

describe("workflow card layout is memoised on its inputs", () => {
  it("reuses the layout for a settled card as the wall clock moves", () => {
    const progress = liveProgress([agentEntry(0), agentEntry(1)]);
    // A settled card's elapsed string is frozen, so the clock is not an input to
    // its layout and must not be allowed to expire the memo once a second.
    const first = layoutWorkflowCard(input({ progress, now: START + 5_000 }));
    const later = layoutWorkflowCard(input({ progress, now: START + 900_000 }));
    expect(later).toBe(first);
  });

  it("reuses the layout across repeated frames with no clock at all", () => {
    const progress = liveProgress([agentEntry(0)]);
    const first = layoutWorkflowCard(input({ progress }));
    expect(layoutWorkflowCard(input({ progress }))).toBe(first);
  });

  it("rebuilds when the progress array grows", () => {
    const progress = liveProgress([agentEntry(0)]);
    const first = layoutWorkflowCard(input({ progress }));
    progress.push(agentEntry(1));
    expect(layoutWorkflowCard(input({ progress }))).not.toBe(first);
  });

  it.each([
    ["status", { status: "running" as const, endTime: undefined }],
    ["totalPausedMs", { totalPausedMs: 250 }],
    ["workflowName", { workflowName: "other" }],
  ])("rebuilds when the task's %s changes", (_label, taskOver) => {
    const progress = liveProgress([agentEntry(0)]);
    const first = layoutWorkflowCard(input({ progress }));
    const task = settledTask(taskOver as Partial<WorkflowCardTask>);
    expect(layoutWorkflowCard({ width: 120, progress, task })).not.toBe(first);
  });

  it.each([
    ["width", { width: 80 }],
    ["ascii", { ascii: true }],
    ["agentCount", { agentCount: 7 }],
    ["totalTokens", { totalTokens: 999 }],
    ["showToolTitle", { showToolTitle: true }],
  ])("rebuilds when the %s input changes", (_label, over) => {
    const progress = liveProgress([agentEntry(0)]);
    const first = layoutWorkflowCard(input({ progress }));
    expect(layoutWorkflowCard(input({ progress, ...over }))).not.toBe(first);
  });

  it("rebuilds a live card once its elapsed second rolls over", () => {
    const progress = liveProgress([agentEntry(0)]);
    const live = { status: "running" as const, workflowName: "review-changes", startTime: START };
    const first = layoutWorkflowCard({ width: 120, progress, task: live, now: START + 1_000 });
    // Same second: still the same card.
    expect(layoutWorkflowCard({ width: 120, progress, task: live, now: START + 1_400 })).toBe(first);
    // Next second: the elapsed string has moved, so the layout must follow it.
    expect(layoutWorkflowCard({ width: 120, progress, task: live, now: START + 2_000 })).not.toBe(first);
  });

  it("keeps separate entries for two runs in the same session", () => {
    const a = liveProgress([agentEntry(0)]);
    const b = liveProgress([agentEntry(0)]);
    const first = layoutWorkflowCard(input({ progress: a }));
    expect(layoutWorkflowCard(input({ progress: b }))).not.toBe(first);
  });
});
