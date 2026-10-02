/**
 * restored-session-resume.test.ts — resuming an agent that the session-start
 * scan rebuilt from a persisted child session.
 *
 * The scan publishes a transcript stand-in (`makeRestoredSession`) on a live
 * record: `messages`, `sessionManager`, `subscribe`, `getSessionStats` — and no
 * `prompt()`. Every resume entry point gated on the *presence* of
 * `record.session`, so `Agent({resume})` handed that stand-in to the resume
 * runner and died on its first statement with `session.prompt is not a
 * function`: 0 tokens, an empty `.output`, and the transcript record flipped to
 * `error` with its historical tool-use count still on it.
 *
 * The runner is deliberately NOT mocked here. `session-restore.test.ts` mocks
 * `resumeAgent`, which is exactly why a fully green suite carried the defect —
 * the mock accepts the stand-in happily. This file drives the real extension,
 * the real `AgentManager` and the real runner against a real `SessionManager`
 * parent and a persisted child, resumes by the ID the caller actually knows,
 * and asserts the conversation was continued on its own session file.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";
import { resolveSubagentSessionDir } from "../src/session-dir.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

// A real child session runs a real pi turn; under full-suite CPU contention a
// cold first run exceeds vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

let hermetic: Hermetic;
let faux: ReturnType<typeof registerFauxProvider>;
let childCwd: string;
let sessionRoot: string;

beforeEach(() => {
  hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
  childCwd = join(hermetic.dir, "child-cwd");
  mkdirSync(childCwd, { recursive: true });
  sessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR!;
  // Every model call answers with the same line, so the child settles on its
  // first turn whatever the run does.
  faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  faux.setResponses([() => fauxAssistantMessage("continued in the reopened session")]);
});

afterEach(() => {
  faux.unregister();
  hermetic.restore();
  vi.unstubAllEnvs();
});

/** A parent session holding the terminal record a restore scan matches against. */
function parentSession(agentId: string, status = "stopped") {
  const parent = SessionManager.create(hermetic.dir, sessionRoot);
  parent.appendCustomEntry("subagents:record", { id: agentId, status, error: "stopped by caller", startedAt: 1 });
  return parent;
}

/** A child session as the runner left it: task, invocation, one exchange. */
function persistedChild(opts: { parentSession: string; agentId: string }) {
  const child = SessionManager.create(childCwd, resolveSubagentSessionDir()!, { parentSession: opts.parentSession });
  child.appendModelChange("faux", "faux-1");
  child.appendSessionInfo(`general-purpose#${opts.agentId.slice(0, 8)}`);
  child.appendCustomEntry("subagents:task", { prompt: "ship the panel" });
  child.appendCustomEntry("subagents:invocation", { agentId: opts.agentId, startedAt: 1 });
  child.appendMessage({ role: "user", content: [{ type: "text", text: "ship the panel" }], timestamp: 1 } as never);
  child.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "half of it is done" }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 2,
  } as never);
  return child.getSessionFile()!;
}

/** Boot the real extension over a parent session, with a model the child can run. */
function boot(parent: SessionManager) {
  const model = faux.getModel();
  const backend = fauxModelBackend(model);
  const { pi, tools, lifecycle } = makePi();
  // The restored-scan fixtures need entries to be readable back and records to
  // be written, which is what a live `pi` does through its own session manager.
  pi.appendEntry = vi.fn((customType: string, data: unknown) => { parent.appendCustomEntry(customType, data); });
  subagentsExtension(pi);
  const context = ctx({
    cwd: hermetic.dir,
    model,
    // runAgent hands the runtime facade down to the child session, which pi
    // >=0.80.8 reads instead of the registry option.
    modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
    sessionManager: parent,
  });
  return { tools, lifecycle, context };
}

/** The `Agent ID:` a reopen reported, which is the record the run actually used. */
function reopenedId(text: string): string {
  const match = /Agent ID: (\S+)/.exec(text);
  expect(match, `no reopened agent id in:\n${text}`).not.toBeNull();
  return match![1];
}

/** The id the restore scan publishes for a persisted child session file. */
async function scanIdFor(childFile: string): Promise<string> {
  const info = (await SessionManager.listAll(resolveSubagentSessionDir()!)).find(session => session.path === childFile);
  expect(info, `no session listed for ${childFile}`).toBeDefined();
  return `restored-${info!.id}`;
}

/** User prompts written to a child session file, oldest first. */
function childPrompts(childFile: string): string[] {
  return SessionManager.open(childFile).getEntries()
    .filter(entry => entry.type === "message" && entry.message.role === "user")
    .map(entry => (entry as { message: { content: Array<{ text: string }> } }).message.content.map(part => part.text).join(""));
}

/**
 * Wait for a run to reach a terminal state without reading its result: the
 * parent session's terminal record is written by the same completion handler
 * that flips the status, and `get_subagent_result` would mark the result
 * consumed, which is the state the sweep on a session boundary acts on.
 */
async function waitForTerminalRecord(parent: SessionManager, id: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const terminal = parent.getEntries().some(entry =>
      entry.type === "custom" && entry.customType === "subagents:record"
      && (entry.data as { id?: unknown } | undefined)?.id === id);
    if (terminal) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`agent ${id} never reached a terminal state`);
}

describe("resuming a session-restored agent", () => {
  it("continues the conversation on its own session file instead of prompting a transcript stand-in", async () => {
    const agentId = "restored-resume-agent-01";
    const parent = parentSession(agentId);
    const childFile = persistedChild({ parentSession: parent.getSessionFile()!, agentId });
    const { tools, lifecycle, context } = boot(parent);

    await lifecycle.get("session_start")?.({}, context);

    const resumed = await tools.get("Agent").execute("tc-resume", {
      prompt: "continue",
      description: "Resume the panel",
      subagent_type: "general-purpose",
      resume: agentId,
      run_in_background: true,
    }, undefined, undefined, context);

    const text = textOf(resumed);
    expect(text).not.toContain("session.prompt is not a function");
    expect(text).toContain("resumed in background from its stored session");
    const newId = reopenedId(text);
    expect(newId).not.toBe(agentId);

    // The run continued the transcript rather than replacing it.
    const settled = await tools.get("get_subagent_result").execute(
      "tc-result", { agent_id: newId, wait: true }, undefined, undefined, context,
    );
    expect(textOf(settled)).toContain("continued in the reopened session");

    expect(childPrompts(childFile)).toEqual(["ship the panel", "continue"]);

    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("answers the resumed ID with the reopened run, not the transcript it replaced", async () => {
    const agentId = "restored-resume-agent-02";
    const parent = parentSession(agentId, "completed");
    const childFile = persistedChild({ parentSession: parent.getSessionFile()!, agentId });
    const { tools, lifecycle, context } = boot(parent);

    await lifecycle.get("session_start")?.({}, context);
    const restoredId = await scanIdFor(childFile);

    const text = textOf(await tools.get("Agent").execute("tc-resume", {
      prompt: "continue",
      description: "Resume the panel",
      subagent_type: "general-purpose",
      resume: agentId,
    }, undefined, undefined, context));
    const newId = reopenedId(text);

    // The ID the caller already knew has to follow the conversation, or every
    // later get_subagent_result/steer/stop on it addresses a dead transcript.
    const byOldId = textOf(await tools.get("get_subagent_result").execute(
      "tc-old-id", { agent_id: agentId, wait: true }, undefined, undefined, context,
    ));
    expect(byOldId).toContain(`Agent: ${newId}`);
    expect(byOldId).toContain("continued in the reopened session");

    // The placeholder is gone with it, so nothing can address a second run on
    // the same session file — and a further resume continues the live record.
    const gone = textOf(await tools.get("get_subagent_result").execute(
      "tc-restored-id", { agent_id: restoredId }, undefined, undefined, context,
    ));
    expect(gone).toContain("Agent not found");
    const second = textOf(await tools.get("Agent").execute("tc-resume-again", {
      prompt: "keep going",
      description: "Resume again",
      subagent_type: "general-purpose",
      resume: agentId,
    }, undefined, undefined, context));
    expect(reopenedId(second)).toBe(newId);

    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("runs one continuation when two resumes of the same restored record race", async () => {
    const agentId = "restored-resume-agent-04";
    const parent = parentSession(agentId);
    const childFile = persistedChild({ parentSession: parent.getSessionFile()!, agentId });
    const { tools, lifecycle, context } = boot(parent);
    // Two answers queued: the pre-fix race is two live runs, and the second one
    // must not fail on an empty queue before the assertions get to look at it.
    faux.setResponses([
      () => fauxAssistantMessage("continued in the reopened session"),
      () => fauxAssistantMessage("continued in the reopened session"),
    ]);

    await lifecycle.get("session_start")?.({}, context);

    // Two `Agent({resume})` calls in one assistant turn, which a model can
    // issue. A reopen awaits the new run's startup before it settles, and the
    // restored record is still in the manager throughout, so both calls reach
    // the restored branch unless one of them is turned away up front.
    const [a, b] = await Promise.all([
      tools.get("Agent").execute("tc-race-a", {
        prompt: "continue",
        description: "Resume the panel",
        subagent_type: "general-purpose",
        resume: agentId,
        run_in_background: true,
      }, undefined, undefined, context),
      tools.get("Agent").execute("tc-race-b", {
        prompt: "continue",
        description: "Resume the panel",
        subagent_type: "general-purpose",
        resume: agentId,
        run_in_background: true,
      }, undefined, undefined, context),
    ]);

    const texts = [textOf(a), textOf(b)];
    const continued = texts.filter(text => text.includes("resumed in background from its stored session"));
    const refused = texts.filter(text => text.includes("it is already being resumed"));
    expect(continued, `no reopen reported:\n${texts.join("\n---\n")}`).toHaveLength(1);
    // Deterministic, not a race-dependent message: the loser is told the run is
    // already under way rather than getting a second live agent.
    expect(refused, `no refusal reported:\n${texts.join("\n---\n")}`).toHaveLength(1);

    // One continuation, not two: a second live run would have appended its own
    // prompt — and its own answer — to the same session file.
    const newId = reopenedId(continued[0]);
    await tools.get("get_subagent_result").execute(
      "tc-race-result", { agent_id: newId, wait: true }, undefined, undefined, context,
    );
    const entries = SessionManager.open(childFile).getEntries();
    expect(childPrompts(childFile)).toEqual(["ship the panel", "continue"]);
    const invocations = entries.filter(entry => entry.type === "custom" && entry.customType === "subagents:invocation");
    expect(invocations).toHaveLength(2);

    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("does not rebuild a transcript for a session file a live run still holds", async () => {
    const agentId = "restored-resume-agent-05";
    const parent = parentSession(agentId);
    const childFile = persistedChild({ parentSession: parent.getSessionFile()!, agentId });
    const { tools, lifecycle, context } = boot(parent);
    // A turn that never arrives: the run has to still be in flight when the
    // scan runs a second time.
    faux.setResponses([() => new Promise<never>(() => {})]);

    await lifecycle.get("session_start")?.({}, context);
    const first = textOf(await tools.get("Agent").execute("tc-live", {
      prompt: "continue",
      description: "Resume the panel",
      subagent_type: "general-purpose",
      resume: agentId,
      run_in_background: true,
    }, undefined, undefined, context));
    const liveId = reopenedId(first);

    // A repeated session_start — what `/reload` emits — runs the scan again with
    // that run still going.
    await lifecycle.get("session_start")?.({ reason: "reload" }, context);

    // The ID the caller has been quoting reaches the live run, and says so.
    const byOldId = textOf(await tools.get("get_subagent_result").execute(
      "tc-old", { agent_id: agentId }, undefined, undefined, context,
    ));
    expect(byOldId).toContain(`Agent: ${liveId}`);
    expect(byOldId).toContain("still running");

    // The scan's own id for the file is the fork: a stand-in record for a
    // conversation that is live right now would let a resume on that address
    // open a second run over the same file.
    const restoredId = await scanIdFor(childFile);
    const viaPlaceholder = textOf(await tools.get("Agent").execute("tc-placeholder", {
      prompt: "continue again",
      description: "Resume via the scan's id",
      subagent_type: "general-purpose",
      resume: restoredId,
      run_in_background: true,
    }, undefined, undefined, context));
    expect(viaPlaceholder).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("does not rebuild a transcript for a session file a settled run still holds", async () => {
    const agentId = "restored-resume-agent-06";
    const parent = parentSession(agentId);
    const childFile = persistedChild({ parentSession: parent.getSessionFile()!, agentId });
    const { tools, lifecycle, context } = boot(parent);

    await lifecycle.get("session_start")?.({}, context);
    const liveId = reopenedId(textOf(await tools.get("Agent").execute("tc-settled", {
      prompt: "continue",
      description: "Resume the panel",
      subagent_type: "general-purpose",
      resume: agentId,
      run_in_background: true,
    }, undefined, undefined, context)));
    // Terminal, with its result still unread: the sweep on a session boundary
    // spares exactly this record, so it is in the manager when the scan runs.
    await waitForTerminalRecord(parent, liveId);

    // `/reload`. Liveness is not the question — the file is that run's
    // conversation for as long as the record holds it.
    await lifecycle.get("session_start")?.({ reason: "reload" }, context);

    // One identity for the file. A second record for it would be a second
    // addressable handle on one conversation, and whichever record answered
    // would depend on map insertion order.
    expect(textOf(await tools.get("get_subagent_result").execute(
      "tc-settled-placeholder", { agent_id: await scanIdFor(childFile) }, undefined, undefined, context,
    ))).toContain("Agent not found");
    const byOldId = textOf(await tools.get("get_subagent_result").execute(
      "tc-settled-old-id", { agent_id: agentId }, undefined, undefined, context,
    ));
    expect(byOldId).toContain(`Agent: ${liveId}`);

    // Continuing is still allowed — it is the record itself that continues, not
    // a second run opened over the same file.
    const continued = textOf(await tools.get("Agent").execute("tc-settled-again", {
      prompt: "keep going",
      description: "Resume again",
      subagent_type: "general-purpose",
      resume: agentId,
      run_in_background: true,
    }, undefined, undefined, context));
    expect(reopenedId(continued)).toBe(liveId);
    await tools.get("get_subagent_result").execute(
      "tc-settled-result", { agent_id: liveId, wait: true }, undefined, undefined, context,
    );
    expect(childPrompts(childFile)).toEqual(["ship the panel", "continue", "keep going"]);

    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("reopens the same conversation from a `@id` mention", async () => {
    const agentId = "restored-resume-agent-03";
    const parent = parentSession(agentId);
    const childFile = persistedChild({ parentSession: parent.getSessionFile()!, agentId });
    const { tools, lifecycle, context } = boot(parent);

    await lifecycle.get("session_start")?.({}, context);
    const restoredId = await scanIdFor(childFile);

    const handled = await lifecycle.get("input")?.({ text: `@${agentId} continue` }, context);

    expect(handled).toEqual({ action: "handled" });
    expect(context.ui.notify).toHaveBeenCalledWith(`Resuming @${agentId}`, "info");
    // The mention reopened the conversation rather than handing the transcript
    // stand-in to the resume runner, so the ID it resolved is now a live run.
    const byOldId = textOf(await tools.get("get_subagent_result").execute(
      "tc-mention", { agent_id: agentId, wait: true }, undefined, undefined, context,
    ));
    expect(byOldId).toContain("continued in the reopened session");
    expect(byOldId).not.toContain(`Agent: ${restoredId}`);

    await lifecycle.get("session_shutdown")?.({}, context);
  });
});
