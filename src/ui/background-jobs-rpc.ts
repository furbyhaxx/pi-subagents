/** Minimal UI-only client for the optional pi-background-jobs menu link. */

import { randomUUID } from "node:crypto";
import type { EventBus, RpcReply } from "../cross-extension-rpc.js";

const PROTOCOL_VERSION = 1;
const PING_TIMEOUT_MS = 2_000;
const CALL_TIMEOUT_MS = 5_000;

export interface BackgroundJobSummary {
  id: string;
  isBackground: boolean;
}

export interface BackgroundJobsMenuRpc {
  readonly available: boolean;
  checkBackgroundJobs(): Promise<boolean>;
  jobList(cwd: string): Promise<BackgroundJobSummary[]>;
  openJobs(cwd: string): Promise<boolean>;
  dispose(): void;
}

function request<T>(
  events: EventBus,
  channel: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  validate: (data: unknown) => data is T,
): Promise<T> {
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const settle = (action: () => void) => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      action();
    };
    unsubscribe = events.on(`${channel}:reply:${requestId}`, raw => {
      const reply = raw as RpcReply<T> | undefined;
      if (reply?.success !== true) {
        settle(() => reject(new Error(reply?.success === false ? reply.error : `${channel} malformed reply`)));
        return;
      }
      const data = reply.data;
      if (!validate(data)) {
        settle(() => reject(new Error(`${channel} malformed data`)));
        return;
      }
      settle(() => resolve(data));
    });
    timer = setTimeout(() => settle(() => reject(new Error(`${channel} timeout`))), timeoutMs);
    events.emit(channel, { requestId, ...params });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createBackgroundJobsMenuRpc(events: EventBus): BackgroundJobsMenuRpc {
  let available = false;

  async function checkBackgroundJobs(): Promise<boolean> {
    try {
      const reply = await request<{ version: number }>(
        events,
        "background-jobs:rpc:ping",
        {},
        PING_TIMEOUT_MS,
        (data): data is { version: number } => isRecord(data) && data.version === PROTOCOL_VERSION,
      );
      available = reply.version === PROTOCOL_VERSION;
    } catch {
      available = false;
    }
    return available;
  }

  const unsubscribeReady = events.on("background-jobs:ready", () => {
    void checkBackgroundJobs();
  });

  return {
    get available() {
      return available;
    },
    checkBackgroundJobs,
    async jobList(cwd) {
      const jobs = await request<BackgroundJobSummary[]>(
        events,
        "background-jobs:rpc:list",
        { cwd, status: "running" },
        CALL_TIMEOUT_MS,
        (data): data is BackgroundJobSummary[] => Array.isArray(data)
          && data.every(job => isRecord(job) && typeof job.id === "string" && typeof job.isBackground === "boolean"),
      );
      return jobs;
    },
    async openJobs(cwd) {
      const result = await request<{ opened: boolean }>(
        events,
        "background-jobs:rpc:open",
        { cwd },
        CALL_TIMEOUT_MS,
        (data): data is { opened: boolean } => isRecord(data) && typeof data.opened === "boolean",
      );
      return result.opened;
    },
    dispose() {
      unsubscribeReady();
    },
  };
}
