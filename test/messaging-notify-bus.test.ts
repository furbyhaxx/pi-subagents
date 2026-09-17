/**
 * Real IPC coverage for the advisory messaging wakeup bus.
 *
 * Election and stale Unix socket behavior are kernel contracts; mocking net
 * would hide the races and cleanup mistakes these tests are meant to catch.
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SocketNotifyBus } from "../src/messaging/socket-notify-bus.js";

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.unref();
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

const unixIt = process.platform === "win32" ? it.skip : it;

describe("SocketNotifyBus", () => {
  const buses: SocketNotifyBus[] = [];
  const sockets: Socket[] = [];
  const directories: string[] = [];

  function directory(): string {
    const path = mkdtempSync(join(tmpdir(), "messaging-notify-test-"));
    directories.push(path);
    return path;
  }

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const bus of buses.splice(0).reverse()) bus.close();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  unixIt("elects one broker and carries bumps in both directions without echoing", async () => {
    const path = join(directory(), "notify.sock");
    const brokerBumps: string[][] = [];
    const clientBumps: string[][] = [];
    const broker = new SocketNotifyBus({ scopeKey: "/project", socketPath: path, onBump: value => brokerBumps.push([...value]) });
    buses.push(broker);
    await broker.ready;
    const client = new SocketNotifyBus({ scopeKey: "/project", socketPath: path, onBump: value => clientBumps.push([...value]) });
    buses.push(client);
    await client.ready;

    client.bump(["agent-from-client"]);
    await eventually(() => expect(brokerBumps).toEqual([["agent-from-client"]]));
    expect(clientBumps).toEqual([]);

    broker.bump(["agent-from-broker"]);
    await eventually(() => expect(clientBumps).toEqual([["agent-from-broker"]]));
    expect(brokerBumps).toEqual([["agent-from-client"]]);
    expect(broker.degraded).toBe(false);
    expect(client.degraded).toBe(false);
  });

  unixIt("promotes a surviving client when the broker closes", async () => {
    const path = join(directory(), "notify.sock");
    const broker = new SocketNotifyBus({ scopeKey: "/project", socketPath: path });
    buses.push(broker);
    await broker.ready;
    const survivor = new SocketNotifyBus({ scopeKey: "/project", socketPath: path });
    buses.push(survivor);
    await survivor.ready;

    broker.close();
    await eventually(() => expect(existsSync(path)).toBe(true));

    const seen: string[][] = [];
    const late = new SocketNotifyBus({ scopeKey: "/project", socketPath: path, onBump: value => seen.push([...value]) });
    buses.push(late);
    await late.ready;
    survivor.bump(["after-promotion"]);

    await eventually(() => expect(seen).toEqual([["after-promotion"]]));
    expect(survivor.degraded).toBe(false);
    expect(late.degraded).toBe(false);
  });

  unixIt("unlinks a stale path and binds it as the broker", async () => {
    const path = join(directory(), "notify.sock");
    writeFileSync(path, "not a socket");
    const bumps: string[][] = [];
    const broker = new SocketNotifyBus({ scopeKey: "/project", socketPath: path, onBump: value => bumps.push([...value]) });
    buses.push(broker);
    await broker.ready;
    const client = new SocketNotifyBus({ scopeKey: "/project", socketPath: path });
    buses.push(client);
    await client.ready;

    client.bump(["after-stale"]);
    await eventually(() => expect(bumps).toEqual([["after-stale"]]));
    expect(broker.degraded).toBe(false);
  });

  unixIt("degrades when the path cannot be bound or connected", async () => {
    const path = join(directory(), "missing", "notify.sock");
    const bus = new SocketNotifyBus({ scopeKey: "/project", socketPath: path });
    buses.push(bus);

    await bus.ready;

    expect(bus.degraded).toBe(true);
    expect(() => bus.bump(["agent"])).not.toThrow();
  });

  unixIt("keeps reporting a broken path as degraded while it retries", async () => {
    // A bump re-runs the election, so without a sticky failure flag the bus
    // reads healthy for the duration of every retry and a "degraded to polling"
    // indicator would blink off against a path that never came back.
    const path = join(directory(), "missing", "notify.sock");
    const bus = new SocketNotifyBus({ scopeKey: "/project", socketPath: path });
    buses.push(bus);
    await bus.ready;

    for (let attempt = 0; attempt < 5; attempt++) {
      bus.bump([`agent-${attempt}`]);
      expect(bus.degraded).toBe(true);
    }

    await eventually(() => expect(bus.degraded).toBe(true));
  });

  unixIt("drops malformed, oversized, and unknown frames without dropping the connection", async () => {
    const path = join(directory(), "notify.sock");
    const bumps: string[][] = [];
    const bus = new SocketNotifyBus({ scopeKey: "/project", socketPath: path, onBump: value => bumps.push([...value]) });
    buses.push(bus);
    await bus.ready;
    const socket = await connect(path);
    sockets.push(socket);

    socket.write('{"t":"bump","mailbox":["malformed"]\n');
    socket.write(`${JSON.stringify({ t: "bump", mailbox: ["oversized"], topics: ["x".repeat(4_096)] })}\n`);
    socket.write(`${JSON.stringify({ t: "future", mailbox: ["unknown"] })}\n`);
    socket.write(`${JSON.stringify({ t: "bump", mailbox: ["valid"] })}\n`);

    await eventually(() => expect(bumps).toEqual([["valid"]]));
    expect(socket.destroyed).toBe(false);
  });

  unixIt("closes the broker with an owner-only socket and removes its path", async () => {
    const path = join(directory(), "notify.sock");
    const bus = new SocketNotifyBus({ scopeKey: "/project", socketPath: path });
    buses.push(bus);
    await bus.ready;

    expect(statSync(path).mode & 0o777).toBe(0o600);
    bus.close();

    expect(existsSync(path)).toBe(false);
  });
});
