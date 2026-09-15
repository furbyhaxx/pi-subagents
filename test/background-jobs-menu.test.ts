import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

interface Request {
  requestId: string;
}

function eventBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel: string, handler: (data: unknown) => void) {
      const listeners = handlers.get(channel) ?? new Set();
      listeners.add(handler);
      handlers.set(channel, listeners);
      return () => listeners.delete(handler);
    },
    emit(channel: string, data: unknown) {
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
    },
  };
}

function installJobsResponder(
  events: ReturnType<typeof eventBus>,
  options: { opened?: boolean } = {},
) {
  const openRequests: Request[] = [];
  events.on("background-jobs:rpc:ping", data => {
    const request = data as Request;
    events.emit(`background-jobs:rpc:ping:reply:${request.requestId}`, {
      success: true,
      data: { version: 1 },
    });
  });
  events.on("background-jobs:rpc:list", data => {
    const request = data as Request;
    events.emit(`background-jobs:rpc:list:reply:${request.requestId}`, {
      success: true,
      data: [
        { id: "job-00000001", isBackground: true },
        { id: "job-00000002", isBackground: false },
      ],
    });
  });
  events.on("background-jobs:rpc:open", data => {
    const request = data as Request;
    openRequests.push(request);
    events.emit(`background-jobs:rpc:open:reply:${request.requestId}`, {
      success: true,
      data: { opened: options.opened ?? true },
    });
  });
  return openRequests;
}

let hermetic: Hermetic | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  hermetic?.restore();
  hermetic = undefined;
});

describe("/agents background-jobs link", () => {
  it("is hidden when the companion has not announced itself", async () => {
    hermetic = hermeticDir();
    const booted = makePi();
    const events = eventBus();
    booted.pi.events = events;
    subagentsExtension(booted.pi);

    const choices: string[][] = [];
    await booted.commands.get("agents").handler("", ctx({
      ui: {
        notify: vi.fn(),
        select: vi.fn(async (_title: string, options: string[]) => {
          choices.push(options);
          return undefined;
        }),
      },
    }));

    expect(choices[0]?.some(choice => choice.startsWith("Jobs ("))).toBe(false);
  });

  it("opens Jobs without recursively reopening a selector over its overlay", async () => {
    hermetic = hermeticDir();
    const booted = makePi();
    const events = eventBus();
    booted.pi.events = events;
    const openRequests = installJobsResponder(events);
    subagentsExtension(booted.pi);
    events.emit("background-jobs:ready", {});
    await flush();

    const choices: string[][] = [];
    let picked = false;
    await booted.commands.get("agents").handler("", ctx({
      cwd: "/repo/feature",
      ui: {
        notify: vi.fn(),
        select: vi.fn(async (_title: string, options: string[]) => {
          choices.push(options);
          if (picked) return undefined;
          picked = true;
          return options.find(option => option === "Jobs (1)");
        }),
      },
    }));

    expect(choices[0]).toContain("Jobs (1)");
    expect(choices).toHaveLength(1);
    expect(openRequests).toHaveLength(1);
  });

  it("points to /jobs when the companion cannot accept an overlay", async () => {
    hermetic = hermeticDir();
    const booted = makePi();
    const events = eventBus();
    booted.pi.events = events;
    installJobsResponder(events, { opened: false });
    subagentsExtension(booted.pi);
    events.emit("background-jobs:ready", {});
    await flush();

    const notify = vi.fn();
    let picked = false;
    const select = vi.fn(async (_title: string, options: string[]) => {
      if (picked) return undefined;
      picked = true;
      return options.find(option => option === "Jobs (1)");
    });
    await booted.commands.get("agents").handler("", ctx({
      ui: {
        notify,
        select,
      },
    }));

    expect(notify).toHaveBeenCalledWith(
      "The jobs overlay could not open here. Run /jobs directly.",
      "warning",
    );
    expect(select).toHaveBeenCalledOnce();
  });
});
