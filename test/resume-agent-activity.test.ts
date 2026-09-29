import { describe, expect, it, vi } from "vitest";
import { resumeAgent } from "../src/agent-runner.js";

describe("resumeAgent streamed activity", () => {
  it("forwards assistant text deltas with the cumulative message text", async () => {
    const listeners = new Set<(event: unknown) => void>();
    const session = {
      messages: [] as unknown[],
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      prompt: vi.fn(async () => {
        for (const listener of listeners) {
          listener({ type: "message_start", message: { role: "assistant" } });
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
        }
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "hello world" }] });
      }),
    };
    const onTextDelta = vi.fn();

    const result = await resumeAgent(session as never, "continue", { onTextDelta });

    expect(result.text).toBe("hello world");
    expect(onTextDelta.mock.calls).toEqual([["hello", "hello"], [" world", "hello world"]]);
    expect(listeners.size).toBe(0);
  });
});
