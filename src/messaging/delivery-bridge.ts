import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { getAgentConfig } from "../agent-types.js";
import type { AgentRow, MessagingSurface, PeerAccess } from "./types.js";

export type LocalRecipientState = "running" | "queued" | "settled" | "gone";

export interface RecipientDeliveryInfo {
  ownership: "local" | "foreign";
  state: LocalRecipientState;
  surface: MessagingSurface;
  kind: "main" | "sub";
  sessionId: string;
}

export interface BridgeDelivery {
  delivered: boolean;
  woken: boolean;
}

export interface DeliveryBridge {
  peerAccess(agent: AgentRow): PeerAccess;
  recipientInfo(agent: AgentRow): RecipientDeliveryInfo;
  isNestedAgentId(agentId: string): boolean;
  deliver(agent: AgentRow, content: string, wake: boolean): Promise<BridgeDelivery>;
}

export interface AgentManagerDeliveryBridgeOptions {
  manager: AgentManager;
  pi: ExtensionAPI;
  mainAgentId: string;
  mainSessionId: string;
  mainSurface: () => MessagingSurface;
}

/** The only adapter allowed to translate mailbox delivery into manager actions. */
export class AgentManagerDeliveryBridge implements DeliveryBridge {
  constructor(private readonly options: AgentManagerDeliveryBridgeOptions) {}

  isNestedAgentId(agentId: string): boolean {
    const record = this.options.manager.getRecord(agentId);
    return record !== undefined && !isTopLevelAgent(record);
  }

  peerAccess(agent: AgentRow): PeerAccess {
    if (agent.pid !== process.pid || agent.sessionId !== this.options.mainSessionId) return "read-only";
    if (agent.agentId === this.options.mainAgentId) return "main";
    const record = this.options.manager.getRecord(agent.agentId);
    return record && isTopLevelAgent(record) && record.rootSessionId === this.options.mainSessionId
      ? "local"
      : "read-only";
  }

  recipientInfo(agent: AgentRow): RecipientDeliveryInfo {
    const access = this.peerAccess(agent);
    if (access === "read-only") {
      return {
        ownership: "foreign",
        state: agent.status === "gone" ? "gone" : agent.status === "settled" || agent.status === "idle" ? "settled" : agent.status,
        surface: "ui",
        kind: agent.kind,
        sessionId: agent.sessionId,
      };
    }
    if (access === "main") {
      return {
        ownership: "local",
        state: "running",
        surface: this.options.mainSurface(),
        kind: "main",
        sessionId: this.options.mainSessionId,
      };
    }
    const record = this.options.manager.getRecord(agent.agentId);
    const state: LocalRecipientState = !record || record.status === "aborted" || record.status === "stopped" || record.status === "error"
      ? "gone"
      : record.status === "running" ? "running"
      : record.status === "queued" ? "queued"
      : "settled";
    return {
      ownership: "local",
      state,
      surface: getAgentConfig(record?.type ?? agent.type)?.messagingSurface ?? this.options.mainSurface(),
      kind: "sub",
      sessionId: agent.sessionId,
    };
  }

  async deliver(agent: AgentRow, content: string, wake: boolean): Promise<BridgeDelivery> {
    const access = this.peerAccess(agent);
    if (access === "read-only") return { delivered: false, woken: false };
    if (access === "main") {
      this.options.pi.sendMessage({ customType: "agent-message", content, display: false }, {
        deliverAs: "nextTurn",
        triggerTurn: wake,
      });
      return { delivered: true, woken: wake };
    }

    const record = this.options.manager.getRecord(agent.agentId);
    if (!record || !isTopLevelAgent(record)) return { delivered: false, woken: false };
    if (record.status === "running" || record.status === "queued") {
      return { delivered: this.options.manager.steer(record.id, content), woken: false };
    }
    if (!wake || !record.session) return { delivered: false, woken: false };
    const resumed = await this.options.manager.resume(record.id, content, undefined, { isBackground: true });
    return { delivered: resumed !== undefined, woken: resumed !== undefined };
  }
}
