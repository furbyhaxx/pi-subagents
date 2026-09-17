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
