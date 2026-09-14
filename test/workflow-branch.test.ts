import { describe, expect, it, vi } from "vitest";
import { journalKey, type WorkflowJournalEntry } from "../src/workflow/journal.js";
import { collapse } from "../src/workflow/progress.js";
import { runWorkflow, type WorkflowHost } from "../src/workflow/runtime.js";
import type { WorktreeInfo } from "../src/worktree.js";

const HEAD = 'export const meta = { name: "branch", description: "branch integration" };\n';
const workspace: WorktreeInfo = {
  path: "/repo/.worktrees/feat-x",
  workPath: "/repo/.worktrees/feat-x/packages/api",
  sourceRoot: "/repo",
  commonDir: "/repo/.git",
  branch: "feat/x",
  baseSha: "abc123",
  lifecycle: "retained",
  reused: true,
  initialDirty: true,
};

function makeHost() {
  return {
    spawnAgent: vi.fn<WorkflowHost["spawnAgent"]>().mockResolvedValue({ ok: true, text: "live", workspace }),
    resumeAgent: vi.fn<NonNullable<WorkflowHost["resumeAgent"]>>().mockResolvedValue({ ok: true, text: "continued", workspace }),
    abortAgent: vi.fn(),
  };
}

describe("workflow branch contract", () => {
  it.each([null, "", "  ", 42])("rejects invalid branch %j before spawning", async branch => {
    const host = makeHost();
    const result = await runWorkflow({ script: HEAD + 'return await agent("work", { branch: args });', args: branch, host });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("opts.branch requires a non-empty string");
    expect(host.spawnAgent).not.toHaveBeenCalled();
  });

  it.each(['resume: "fix"', 'isolation: "off"'])("rejects branch combined with %s", async other => {
    const host = makeHost();
    const result = await runWorkflow({ script: `${HEAD}return await agent("work", { branch: "feat/x", ${other} });`, host });
    expect(result.status).toBe("failed");
    expect(host.spawnAgent).not.toHaveBeenCalled();
  });

  it("forwards exact branch and reports scope outside structured output", async () => {
    const host = makeHost();
    host.spawnAgent.mockResolvedValue({ ok: true, text: '{"done":true}', workspace });
    const result = await runWorkflow({
      script: HEAD + 'return await agent("work", { branch: "feat/x", isolation: "worktree", schema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] } });',
      host,
    });
    expect(host.spawnAgent.mock.calls[0][0]).toMatchObject({ branch: "feat/x", isolation: "worktree" });
    expect(result.value).toEqual({ done: true });
    expect(collapse(result.progress).agents[0]).toMatchObject({ branch: "feat/x", workspace, resultPreview: '{"done":true}' });
  });

  it("includes branch in journal identity and ends replay AT that call", async () => {
    expect(journalKey({ prompt: "work", branch: "feat/x" })).not.toBe(journalKey({ prompt: "work", branch: "feat/y" }));
    expect(journalKey({ prompt: "work", branch: "feat/x" })).not.toBe(journalKey({ prompt: "work" }));
    const script = HEAD + 'await agent("scout"); await agent("work", { branch: "feat/x" }); return await agent("verify");';
    const entries: WorkflowJournalEntry[] = [];
    await runWorkflow({ script, host: makeHost(), journal: { append: entry => entries.push(entry) } });
    const host = makeHost();
    const result = await runWorkflow({ script, host, journal: { entries } });
    expect(result.replayedCount).toBe(1);
    expect(host.spawnAgent.mock.calls.map(([request]) => request.prompt)).toEqual(["work", "verify"]);
  });

  it("keeps branch scope for continuation without retargeting or replaying it", async () => {
    const script = HEAD + 'await agent("work", { branch: "feat/x", label: "fix" }); return await agent("more", { resume: "fix" });';
    const entries: WorkflowJournalEntry[] = [];
    await runWorkflow({ script, host: makeHost(), journal: { append: entry => entries.push(entry) } });
    const host = makeHost();
    const result = await runWorkflow({ script, host, journal: { entries } });
    expect(result.replayedCount).toBe(0);
    expect(host.spawnAgent).toHaveBeenCalledTimes(1);
    expect(host.resumeAgent).toHaveBeenCalledWith("wf-agent-0", "more", expect.any(Function));
    expect(result.value).toBe("continued");
    expect(collapse(result.progress).agents[1]).toMatchObject({ branch: "feat/x", workspace });
  });
});
