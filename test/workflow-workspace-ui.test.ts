import { describe, expect, it } from "vitest";
import { initialWorkflowDialogState, layoutWorkflowDialog, plainWorkflowDialogLines } from "../src/ui/workflow-dialog.js";
import type { WorkflowAgentEntry } from "../src/workflow/progress.js";

const entry: WorkflowAgentEntry = {
  type: "workflow_agent", index: 0, label: "implement", state: "done", branch: "feat/x", cwd: "/worktrees/x/api",
  workspace: {
    path: "/worktrees/x", workPath: "/worktrees/x/api", branch: "feat/x", baseSha: "abc",
    lifecycle: "retained", sourceRoot: "/repo", commonDir: "/repo/.git", reused: true, initialDirty: true,
  },
};

describe("workflow workspace detail", () => {
  it("shows verified retained scope independently of the child's result", () => {
    const text = plainWorkflowDialogLines(layoutWorkflowDialog({
      progress: [entry], task: { status: "completed", startTime: 0, endTime: 1 }, width: 120,
      state: { ...initialWorkflowDialogState(), level: "agent" },
    })).join("\n");
    expect(text).toContain("Workspace · retained · reused");
    expect(text).toContain("Branch: feat/x");
    expect(text).toContain("Root: /worktrees/x");
    expect(text).toContain("Cwd: /worktrees/x/api");
  });
});
