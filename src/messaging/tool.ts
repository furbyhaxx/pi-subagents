import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AgentMessagingService } from "./service.js";
import type { MessagingCaller } from "./types.js";

export type MessagingCallerResolver = (ctx: ExtensionContext) => MessagingCaller | undefined;

function result(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: undefined,
    isError,
  };
}

/**
 * The mailbox and the board are registered together — an agent that can address
 * peers can also read what they wrote down — so every admission decision in the
 * runner works on the pair rather than on one tool at a time.
 */
export function createMessagingTools(
  getService: () => AgentMessagingService | undefined,
  resolveCaller: MessagingCallerResolver,
): ToolDefinition[] {
  return [
    createAgentMessageTool(getService, resolveCaller),
    createBlackboardTool(getService, resolveCaller),
  ];
}

export function createAgentMessageTool(
  getService: () => AgentMessagingService | undefined,
  resolveCaller: MessagingCallerResolver,
): ToolDefinition {
  return defineTool({
    name: "AgentMessage",
    label: "Agent Message",
    description: "Send durable messages to peers, read your mailbox, wait for mail, or inspect the scoped peer roster.",
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("send"),
        Type.Literal("broadcast"),
        Type.Literal("inbox"),
        Type.Literal("wait"),
        Type.Literal("peers"),
      ]),
      to: Type.Optional(Type.String({ description: "Recipient handle or agent id for send." })),
      message: Type.Optional(Type.String({ description: "Message body for send or broadcast." })),
      expect_reply: Type.Optional(Type.Boolean({ description: "Send a request with a correlation id." })),
      reply_to: Type.Optional(Type.String({ description: "Message id being answered." })),
      from: Type.Optional(Type.String({ description: "Only accept messages from this sender when waiting." })),
      timeout_ms: Type.Optional(Type.Number({ minimum: 0, description: "How long wait polls for mail." })),
      peek: Type.Optional(Type.Boolean({ description: "Read inbox without consuming messages." })),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const service = getService();
      const caller = resolveCaller(ctx);
      if (!service || !caller) return result({ ok: false, reason: "messaging-unavailable" });
      try {
        if (params.op === "send") {
          if (!params.to || params.message === undefined) {
            return result({ ok: false, reason: "send-requires-to-and-message" });
          }
          return result(await service.send(caller, {
            to: params.to,
            message: params.message,
            expectReply: params.expect_reply,
            replyTo: params.reply_to,
          }));
        }
        if (params.op === "broadcast") {
          if (params.message === undefined) return result({ ok: false, reason: "broadcast-requires-message" });
          return result(await service.broadcast(caller, params.message));
        }
        if (params.op === "inbox") return result({ ok: true, messages: service.inbox(caller, params.peek) });
        if (params.op === "wait") {
          const message = await service.wait(caller, params.timeout_ms ?? 30_000, params.from, signal);
          return result({ ok: true, message: message ?? null });
        }
        return result({ ok: true, peers: service.peers() });
      } catch (error) {
        return result({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}

export function createBlackboardTool(
  getService: () => AgentMessagingService | undefined,
  resolveCaller: MessagingCallerResolver,
): ToolDefinition {
  return defineTool({
    name: "Blackboard",
    label: "Blackboard",
    description: "Read and write the shared blackboard: durable key/value entries grouped by topic, with optimistic concurrency and a change feed.",
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("put"),
        Type.Literal("get"),
        Type.Literal("list"),
        Type.Literal("delete"),
        Type.Literal("watch"),
      ]),
      topic: Type.Optional(Type.String({ description: "Topic to act on. Required except for an untopiced list or watch." })),
      key: Type.Optional(Type.String({ description: "Entry key for put, get and delete." })),
      value: Type.Optional(Type.Any({ description: "JSON-shaped value to store. Required for put." })),
      if_revision: Type.Optional(Type.Number({
        minimum: 0,
        description: "Put only if the entry is still at this revision; 0 means it must not exist. A mismatch returns the current value and author instead of overwriting.",
      })),
      since: Type.Optional(Type.Number({
        minimum: 0,
        description: "Change-feed cursor for watch. Omit to start from the present and see only what happens next; 0 replays the whole log.",
      })),
      timeout_ms: Type.Optional(Type.Number({ minimum: 0, description: "How long watch blocks before returning no changes." })),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const service = getService();
      const caller = resolveCaller(ctx);
      if (!service || !caller) return result({ ok: false, reason: "messaging-unavailable" });
      try {
        if (params.op === "put") {
          if (!params.topic || !params.key || params.value === undefined) {
            return result({ ok: false, reason: "put-requires-topic-key-and-value" });
          }
          const put = service.boardPut(caller, {
            topic: params.topic,
            key: params.key,
            value: params.value,
            ifRevision: params.if_revision,
          });
          // A conflict is an answer, not a failure: it carries the current value
          // and author so the caller can retry, merge or defer (§7.1). Flagging
          // it as a tool error would tell the model to stop reading there.
          return result(put);
        }
        if (params.op === "get") {
          if (!params.topic || !params.key) return result({ ok: false, reason: "get-requires-topic-and-key" });
          return result({ ok: true, entry: service.boardGet(params.topic, params.key) ?? null });
        }
        if (params.op === "list") {
          return result({ ok: true, entries: service.boardList(params.topic) });
        }
        if (params.op === "delete") {
          if (!params.topic || !params.key) return result({ ok: false, reason: "delete-requires-topic-and-key" });
          return result(service.boardDelete(caller, params.topic, params.key));
        }
        const since = params.since ?? service.boardCursor();
        const watched = await service.boardWatch(since, params.timeout_ms ?? 30_000, params.topic, signal);
        return result({ ok: true, ...watched });
      } catch (error) {
        return result({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}
