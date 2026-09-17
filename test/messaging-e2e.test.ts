import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGING_ENTRY_TYPE, type MessageCardData } from "../src/messaging/entry.js";
import { agentCall, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

function toolResults(context: Context, name: string): string[] {
  return context.messages
    .filter(message => message.role === "toolResult" && (message as { toolName?: string }).toolName === name)
    .flatMap(message => message.content)
    .map(content => content.type === "text" ? content.text : "");
}

function promptText(context: Context): string {
  return context.messages
    .filter(message => message.role === "user")
    .flatMap(message => typeof message.content === "string" ? [message.content] : message.content)
    .map(content => typeof content === "string" ? content : content.type === "text" ? content.text : "")
    .join("\n");
}

function sessionToolResults(session: AgentSession, name: string): string[] {
  return session.messages
    .filter(message => message.role === "toolResult" && message.toolName === name)
    .flatMap(message => message.content)
    .map(content => content.type === "text" ? content.text : "");
}

describe("agent messaging e2e", () => {
  let run: PrintModeRun | undefined;
  const directories: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("registers both messaging tools for a peer-capable main session and attributes its board writes", async () => {
    run = await runPrintMode({
      prompt: "Inspect messaging peers, then record a finding.",
      live: false,
      respond: (context: Context) => {
        if (!toolResults(context, "AgentMessage")[0]) return fauxToolCall("AgentMessage", { op: "peers" });
        if (!toolResults(context, "Blackboard")[0]) {
          return fauxToolCall("Blackboard", { op: "put", topic: "findings", key: "e2e", value: { ok: true } });
        }
        return "MESSAGING_ROSTER_OK";
      },
    });

    const tools = run.parentSession.getAllTools().map(tool => tool.name);
    const resultText = sessionToolResults(run.parentSession, "AgentMessage").join("\n");
    // The main session writes under the name a human would address it by — its
    // session alias here, `main-<short>` when the session is unnamed — which is
    // what makes a board entry attributable to a peer rather than anonymous.
    const roster = JSON.parse(sessionToolResults(run.parentSession, "AgentMessage")[0]!) as {
      peers: Array<{ kind: string; alias?: string; handle?: string }>;
    };
    const main = roster.peers.find(peer => peer.kind === "main")!;
    const board = JSON.parse(sessionToolResults(run.parentSession, "Blackboard")[0]!) as {
      ok: boolean;
      entry: { author: string; revision: number };
    };
    expect(tools).toContain("AgentMessage");
    expect(tools).toContain("Blackboard");
    expect(resultText).toContain('"kind": "main"');
    expect(board).toMatchObject({
      ok: true,
      entry: { author: main.alias ?? main.handle, revision: 1 },
    });
    expect(run.responseText).toBe("MESSAGING_ROSTER_OK");
  });

  it("lets two live top-level subagents exchange a correlated request and reply", async () => {
    run = await runPrintMode({
      prompt: "Start both messaging peers.",
      live: false,
      maxModelCalls: 24,
      respond: async (context: Context) => {
        const prompt = promptText(context);
        if (prompt.includes("receiver-peer")) {
          const waits = toolResults(context, "AgentMessage");
          if (waits.length === 0) {
            return fauxToolCall("AgentMessage", {
              op: "wait",
              from: "general-purpose-2",
              timeout_ms: 5_000,
            });
          }
          const request = JSON.parse(waits[0]!) as { message: { id: string } };
          if (waits.length === 1) {
            return fauxToolCall("AgentMessage", {
              op: "send",
              to: "general-purpose-2",
              message: "correlated-answer",
              reply_to: request.message.id,
            });
          }
          return "RECEIVER_DONE";
        }
        if (prompt.includes("sender-peer")) {
          const results = toolResults(context, "AgentMessage");
          if (results.length === 0) {
            return fauxToolCall("AgentMessage", {
              op: "send",
              to: "general-purpose",
              message: "correlated-question",
              expect_reply: true,
            });
          }
          if (results.length === 1) {
            return fauxToolCall("AgentMessage", {
              op: "wait",
              from: "general-purpose",
              timeout_ms: 5_000,
            });
          }
          return "SENDER_DONE";
        }
        if (toolResults(context, "Agent").length > 0) return "PEERS_DONE";
        return [
          agentCall({ prompt: "receiver-peer", description: "message receiver", run_in_background: true }),
          agentCall({ prompt: "sender-peer", description: "message sender", run_in_background: true }),
        ];
      },
    });

    const records = sessionToolResults(run.parentSession, "Agent")
      .map(text => /Agent ID: (\S+)/.exec(text)?.[1])
      .filter((id): id is string => id !== undefined)
      .map(id => run?.manager?.getRecord(id) as { session?: AgentSession });
    const messagingResults = records.flatMap(record => record.session ? sessionToolResults(record.session, "AgentMessage") : []);
    const requestReceipt = JSON.parse(messagingResults.find(text => text.includes('"status": "injected"') && text.includes('"correlationId"'))!) as {
      receipt: { correlationId: string };
    };
    const reply = JSON.parse(messagingResults.find(text => text.includes('"kind": "reply"'))!) as {
      message: { correlationId: string; body: string };
    };

    // Peer-to-peer traffic the main session is not an endpoint of is the case
    // transcript cards exist for: without them the human sees two agents go
    // quiet and has no way to know they were talking to each other.
    const cards = run.parentSession.sessionManager.getEntries()
      .filter((entry): entry is typeof entry & { data: MessageCardData } =>
        entry.type === "custom" && entry.customType === MESSAGING_ENTRY_TYPE)
      .map(entry => entry.data);

    expect(records.every(record => record.session?.getAllTools().some(tool => tool.name === "AgentMessage"))).toBe(true);
    expect(records.every(record => record.session?.getAllTools().some(tool => tool.name === "Blackboard"))).toBe(true);
    expect(cards).toMatchObject([
      { kind: "message", messageKind: "request", body: "correlated-question" },
      { kind: "message", messageKind: "reply", body: "correlated-answer" },
    ]);
    expect(cards.every(card => card.session === undefined)).toBe(true);
    expect(reply.message.body).toBe("correlated-answer");
    expect(reply.message.correlationId).toBe(requestReceipt.receipt.correlationId);
  });

  it("passes the configured operator topic prefix into the store", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "messaging-operator-prefix-e2e-"));
    directories.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "subagents.json"),
      JSON.stringify({ messaging: { operatorTopicPrefix: "human/" } }),
    );

    run = await runPrintMode({
      cwd,
      prompt: "Try to overwrite the operator constraint.",
      live: false,
      respond: (context: Context) => {
        const results = toolResults(context, "Blackboard");
        if (results.length === 0) {
          return fauxToolCall("Blackboard", {
            op: "put",
            topic: "human/constraints",
            key: "rule",
            value: "overwrite",
          });
        }
        return results[0]!;
      },
    });

    expect(run.responseText).toContain('"reason": "read-only-namespace"');
  });

  it("keeps messaging tools out of an isolated top-level agent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "messaging-isolated-e2e-"));
    directories.push(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "isolated-peer.md"),
      "---\ndescription: isolated messaging probe\nisolated: true\n---\nInspect your tools.\n",
    );
    let isolatedTools: string[] | undefined;

    run = await runPrintMode({
      cwd,
      prompt: "Run the isolated messaging probe.",
      live: false,
      respond: (context: Context) => {
        if (promptText(context).includes("isolated-child")) {
          isolatedTools = (context.tools ?? []).map(tool => tool.name);
          return "ISOLATED_DONE";
        }
        if (toolResults(context, "Agent").length > 0) return "PROBE_DONE";
        return agentCall({
          subagent_type: "isolated-peer",
          prompt: "isolated-child",
          description: "isolated messaging probe",
          run_in_background: false,
        });
      },
    });

    expect(isolatedTools).toBeDefined();
    expect(isolatedTools).not.toContain("AgentMessage");
    expect(isolatedTools).not.toContain("Blackboard");
    expect(run.responseText).toBe("PROBE_DONE");
  });

  it("refuses a parent-owned nested child through a real peer AgentMessage call", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "messaging-nested-e2e-"));
    directories.push(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "owner.md"),
      "---\ndescription: nested owner\nallowed_subagents: all\n---\nOwn a nested child.\n",
    );

    let nestedId: string | undefined;
    let nestedTools: string[] | undefined;
    let publishNested: (() => void) | undefined;
    const nestedPublished = new Promise<void>(resolve => { publishNested = resolve; });
    let markNestedEntered: (() => void) | undefined;
    const nestedEntered = new Promise<void>(resolve => { markNestedEntered = resolve; });
    let releaseNested: (() => void) | undefined;
    const nestedRelease = new Promise<void>(resolve => { releaseNested = resolve; });

    run = await runPrintMode({
      cwd,
      prompt: "Run owner and probe.",
      live: false,
      maxModelCalls: 24,
      respond: async (context: Context) => {
        const prompt = promptText(context);
        if (prompt.includes("nested-child")) {
          nestedTools = (context.tools ?? []).map(tool => tool.name);
          markNestedEntered?.();
          await nestedRelease;
          return "NESTED_DONE";
        }
        if (prompt.includes("owner-peer")) {
          const spawned = toolResults(context, "Agent");
          if (spawned.length === 0) {
            return agentCall({
              prompt: "nested-child",
              description: "owned nested child",
              run_in_background: true,
            });
          }
          nestedId = /Agent ID: (\S+)/.exec(spawned[0]!)?.[1];
          publishNested?.();
          await nestedEntered;
          await nestedRelease;
          return "OWNER_DONE";
        }
        if (prompt.includes("probe-peer")) {
          await nestedPublished;
          const results = toolResults(context, "AgentMessage");
          if (results.length === 0) {
            return fauxToolCall("AgentMessage", { op: "send", to: nestedId, message: "forbidden" });
          }
          releaseNested?.();
          return results[0]!;
        }
        if (toolResults(context, "Agent").length > 0) return "PROBE_DONE";
        return [
          agentCall({ subagent_type: "owner", prompt: "owner-peer", description: "nested owner", run_in_background: true }),
          agentCall({ prompt: "probe-peer", description: "nested target probe", run_in_background: true }),
        ];
      },
    });

    const probeRecord = sessionToolResults(run.parentSession, "Agent")
      .map(text => /Agent ID: (\S+)/.exec(text)?.[1])
      .filter((id): id is string => id !== undefined)
      .map(id => run?.manager?.getRecord(id) as { description?: string; session?: AgentSession })
      .find(record => record.description === "nested target probe");
    const refusal = probeRecord?.session ? sessionToolResults(probeRecord.session, "AgentMessage").join("\n") : "";
    expect(nestedTools).toBeDefined();
    expect(nestedTools).not.toContain("AgentMessage");
    expect(nestedTools).not.toContain("Blackboard");
    expect(refusal).toContain('"reason": "nested-child"');
  });
});
