import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { TranscriptModel } from "../src/ui/transcript-model.js";

const timestamp = 1_700_000_000_000;

function user(content: string, at = timestamp) {
  return { role: "user", content, timestamp: at } as any;
}

function assistant(content: any[], at = timestamp + 1) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: at,
  } as any;
}

function result(id: string, text: string, isError = false, details?: unknown) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError,
    details,
    timestamp: timestamp + 2,
  } as any;
}

function entry(id: string, message: any): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: new Date(message.timestamp).toISOString(), message } as SessionEntry;
}

describe("TranscriptModel", () => {
  it("uses exact taskPrompt before persisted metadata and inherited fallback text", () => {
    const branch: SessionEntry[] = [
      { type: "custom", customType: "subagents:task", data: { prompt: "persisted task" }, id: "task", parentId: null, timestamp: new Date(timestamp).toISOString() },
      entry("user", user("parent context\n# Your Task (below)\n\nfallback task\n<worktree_scope>\nmetadata\n</worktree_scope>")),
    ];

    expect(new TranscriptModel(branch, { taskPrompt: "exact task" }).current().task).toBe("exact task");
    expect(new TranscriptModel(branch).current().task).toBe("persisted task");
    expect(new TranscriptModel([branch[1]!]).current().task).toBe("fallback task");
  });

  it("pairs out-of-order results, retains arguments and labels orphan results", () => {
    const call = assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }]);
    const orphan = result("gone", "compacted call result", true);
    const paired = result("call-1", "3 tests passed");
    const model = new TranscriptModel([entry("orphan", orphan), entry("result", paired), entry("assistant", call)]);
    const snapshot = model.current();

    const bash = snapshot.steps.find((step) => step.toolCallId === "call-1");
    expect(bash).toMatchObject({ label: "bash", target: "npm test", running: false, outcome: "3 tests passed" });
    expect(bash?.bodySections?.map((section) => section.label)).toEqual(["Arguments", "Result"]);
    expect(snapshot.steps.find((step) => step.toolCallId === "gone")).toMatchObject({ isError: true, label: "read" });
  });

  it("does not duplicate message_end followed by entry_appended", () => {
    const message = result("call", "done");
    const model = new TranscriptModel();
    model.handleEvent({ type: "message_end", message } as AgentSessionEvent);
    model.handleEvent({ type: "entry_appended", entry: entry("persisted-result", message) } as AgentSessionEvent);

    expect(model.current().raw).toHaveLength(1);
    expect(model.current().steps).toHaveLength(1);
  });

  it("keeps separate fresh-object text messages distinct after message_end", () => {
    const model = new TranscriptModel();

    model.handleEvent({ type: "message_start", message: assistant([{ type: "text", text: "first" }]) } as AgentSessionEvent);
    model.handleEvent({ type: "message_end", message: assistant([{ type: "text", text: "first" }]) } as AgentSessionEvent);
    model.handleEvent({ type: "message_start", message: assistant([{ type: "text", text: "second" }], timestamp + 10) } as AgentSessionEvent);

    const snapshot = model.current();
    expect(snapshot.raw).toHaveLength(2);
    expect(snapshot.steps.map((step) => step.body)).toEqual(["first", "second"]);
  });

  it("keeps a text stream identity when a tool call appears later", () => {
    const model = new TranscriptModel();

    model.handleEvent({ type: "message_start", message: assistant([{ type: "text", text: "working" }]) } as AgentSessionEvent);
    model.handleEvent({ type: "message_update", message: assistant([{ type: "toolCall", id: "call-stream", name: "read", arguments: { path: "a.ts" } }]) } as AgentSessionEvent);

    const snapshot = model.current();
    expect(snapshot.raw).toHaveLength(1);
    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0]).toMatchObject({ toolCallId: "call-stream", running: true });
  });

  it("shows successful live compactions", () => {
    const model = new TranscriptModel([entry("assistant", assistant([{ type: "text", text: "before" }]))]);

    model.handleEvent({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: { summary: "older work", firstKeptEntryId: "assistant", tokensBefore: 1234 },
    } as AgentSessionEvent);

    expect(model.current().steps.some((step) => step.kind === "compaction" && step.body === "older work")).toBe(true);
  });

  it("keeps fresh-object text stream updates as one live message", () => {
    const model = new TranscriptModel();

    model.handleEvent({ type: "message_start", message: assistant([{ type: "text", text: "" }]) } as AgentSessionEvent);
    model.handleEvent({ type: "message_update", message: assistant([{ type: "text", text: "alpha" }]) } as AgentSessionEvent);
    model.handleEvent({ type: "message_update", message: assistant([{ type: "text", text: "bravo" }]) } as AgentSessionEvent);

    const snapshot = model.current();
    expect(snapshot.raw).toHaveLength(1);
    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0]).toMatchObject({ kind: "text", body: "bravo" });
  });

  it("detects same-length live replacement and preserves historical compactions", () => {
    const message = assistant([{ type: "text", text: "first" }]);
    const compact: SessionEntry = {
      type: "compaction",
      id: "compact",
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      summary: "older work retained",
      firstKeptEntryId: "assistant",
      tokensBefore: 42_000,
    };
    const model = new TranscriptModel([compact, entry("assistant", message)]);
    const key = model.current().steps.find((step) => step.kind === "text")?.key;

    message.content[0].text = "other";
    model.handleEvent({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "" } } as AgentSessionEvent);
    const snapshot = model.current();

    expect(snapshot.steps.some((step) => step.kind === "compaction" && step.body === "older work retained")).toBe(true);
    expect(snapshot.steps.find((step) => step.kind === "text")).toMatchObject({ key, body: "other" });
  });

  it("rolls up only settled successful reads and exposes selectable members", () => {
    const messages: any[] = [user("task")];
    for (let index = 0; index < 5; index++) {
      const id = `read-${index}`;
      messages.push(assistant([{ type: "toolCall", id, name: "read", arguments: { path: `src/${index}.ts` } }], timestamp + index * 10));
      messages.push(result(id, `file ${index}`));
    }
    const model = new TranscriptModel();
    const snapshot = model.sync(messages);

    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0]).toMatchObject({ kind: "rollup", summary: "read ×5" });
    expect(snapshot.steps[0]?.children?.map((step) => step.target)).toEqual([
      "src/0.ts", "src/1.ts", "src/2.ts", "src/3.ts", "src/4.ts",
    ]);
  });
});
