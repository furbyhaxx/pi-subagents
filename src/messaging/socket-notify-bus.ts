/**
 * socket-notify-bus.ts — advisory cross-process mailbox wakeups over local IPC.
 *
 * The socket never carries message content or correctness: SQLite does. The
 * easy failure mode here is turning a stale path, malformed peer, or dead
 * broker into an application failure instead of quietly falling back to polls.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NotifyBus } from "./notify-bus.js";
import type { MessagingTransportMode } from "./types.js";

const MAX_FRAME_BYTES = 4 * 1024;

type BusState = "starting" | "broker" | "client" | "degraded" | "closed";
type ListenResult = "listening" | "in-use" | "failed";

export interface SocketNotifyBusOptions {
  scopeKey: string;
  socketPath?: string;
  onBump?: (mailboxes: readonly string[]) => void;
}

function scopeHash(scopeKey: string): string {
  // Keep below the short sockaddr_un limit on macOS even when tmpdir is long.
  return createHash("sha256").update(scopeKey).digest("hex").slice(0, 16);
}

export function defaultNotifySocketPath(scopeKey: string): string {
  const hash = scopeHash(scopeKey);
  return process.platform === "win32"
    ? `\\\\?\\pipe\\pi-subagents-${hash}`
    : join(process.env.XDG_RUNTIME_DIR || tmpdir(), "pi-subagents", `${hash}.sock`);
}

function errno(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as Error & { code?: unknown }).code)
    : undefined;
}

function parseFrame(line: Buffer): Record<string, unknown> | undefined {
  if (line.byteLength > MAX_FRAME_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** Keep an unterminated oversized frame from becoming an unbounded buffer. */
function readFrames(socket: Socket, receive: (line: Buffer) => void): void {
  let pending = Buffer.alloc(0);
  let discarding = false;
  socket.on("data", chunk => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.byteLength) {
      const newline = data.indexOf(0x0a, offset);
      if (discarding) {
        if (newline < 0) return;
        discarding = false;
        offset = newline + 1;
        continue;
      }
      if (newline < 0) {
        pending = Buffer.concat([pending, data.subarray(offset)]);
        if (pending.byteLength > MAX_FRAME_BYTES) {
          pending = Buffer.alloc(0);
          discarding = true;
        }
        return;
      }
      const suffix = data.subarray(offset, newline);
      const line = pending.byteLength > 0 ? Buffer.concat([pending, suffix]) : suffix;
      pending = Buffer.alloc(0);
      receive(line);
      offset = newline + 1;
    }
  });
}

function encodeBump(mailboxes: readonly string[]): string | undefined {
  const frame = `${JSON.stringify({ t: "bump", mailbox: mailboxes })}\n`;
  return Buffer.byteLength(frame) - 1 <= MAX_FRAME_BYTES ? frame : undefined;
}

export class SocketNotifyBus implements NotifyBus {
  readonly ready: Promise<void>;
  readonly path: string;

  private state: BusState = "starting";
  private readonly scope: string;
  private readonly usesDefaultPath: boolean;
  private readonly onBump: ((mailboxes: readonly string[]) => void) | undefined;
  private server: Server | undefined;
  private client: Socket | undefined;
  private everDegraded = false;
  private readonly peers = new Set<Socket>();

  constructor(options: SocketNotifyBusOptions) {
    this.scope = scopeHash(options.scopeKey);
    this.usesDefaultPath = options.socketPath === undefined;
    this.path = options.socketPath ?? defaultNotifySocketPath(options.scopeKey);
    this.onBump = options.onBump;
    this.ready = this.runElection();
  }

  get mode(): MessagingTransportMode {
    if (this.state === "closed") return "off";
    if (this.state === "broker" || this.state === "client") return "socket";
    if (this.state === "degraded" || this.everDegraded) return "degraded";
    return "starting";
  }

  get degraded(): boolean {
    if (this.state === "broker" || this.state === "client" || this.state === "closed") return false;
    // A retry in flight is not a recovery. `bump()` re-runs the election, so
    // without the sticky flag the bus reads healthy for the duration of every
    // attempt and a surface reporting "degraded to polling" would blink off
    // against a path that never came back. Once a bus has lost the socket,
    // every later window in which it is not attached counts as degraded.
    return this.state === "degraded" || this.everDegraded;
  }

  bump(mailboxes: readonly string[]): void {
    if (this.state === "closed") return;
    if (this.state === "degraded") {
      this.state = "starting";
      void this.runElection().then(() => {
        if (this.state === "broker" || this.state === "client") this.bump(mailboxes);
      });
      return;
    }
    const unique = [...new Set(mailboxes)];
    if (unique.length === 0) return;

    let batch: string[] = [];
    for (const mailbox of unique) {
      const candidate = [...batch, mailbox];
      if (encodeBump(candidate) !== undefined) {
        batch = candidate;
        continue;
      }
      if (batch.length > 0) this.sendBump(batch);
      batch = encodeBump([mailbox]) === undefined ? [] : [mailbox];
    }
    if (batch.length > 0) this.sendBump(batch);
  }

  close(): void {
    if (this.state === "closed") return;
    const wasBroker = this.state === "broker";
    this.state = "closed";

    if (this.client) {
      try {
        this.client.end(`${JSON.stringify({ t: "bye" })}\n`);
      } catch {
        this.client.destroy();
      }
      this.client = undefined;
    }
    for (const peer of this.peers) peer.destroy();
    this.peers.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // A failed election can leave a server object that never started.
      }
      this.server = undefined;
    }
    if (wasBroker) this.unlinkPath();
  }

  private async elect(): Promise<void> {
    if (process.platform !== "win32" && this.usesDefaultPath) {
      try {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        chmodSync(dirname(this.path), 0o700);
      } catch {
        this.degrade();
        return;
      }
    }

    for (let attempt = 0; attempt < 2 && this.state === "starting"; attempt++) {
      const listen = await this.tryListen();
      if (listen === "listening" || this.state !== "starting") return;
      if (listen !== "in-use") break;
      if (await this.tryConnect()) return;
      if (attempt === 0) this.unlinkPath();
    }
    this.degrade();
  }

  private tryListen(): Promise<ListenResult> {
    return new Promise(resolve => {
      const server = createServer(socket => this.accept(socket));
      this.server = server;
      const failed = (error: Error) => {
        if (this.server === server) this.server = undefined;
        resolve(errno(error) === "EADDRINUSE" ? "in-use" : "failed");
      };
      server.once("error", failed);
      server.listen(this.path, () => {
        server.off("error", failed);
        if (this.state !== "starting") {
          server.close();
          resolve("failed");
          return;
        }
        try {
          if (process.platform !== "win32") chmodSync(this.path, 0o600);
        } catch {
          server.close();
          if (this.server === server) this.server = undefined;
          this.unlinkPath();
          resolve("failed");
          return;
        }
        server.on("error", () => this.degrade());
        server.unref();
        this.state = "broker";
        resolve("listening");
      });
    });
  }

  private tryConnect(): Promise<boolean> {
    return new Promise(resolve => {
      const socket = createConnection(this.path);
      let connected = false;
      const failed = () => {
        if (!connected) resolve(false);
      };
      socket.once("error", failed);
      socket.once("connect", () => {
        connected = true;
        socket.off("error", failed);
        if (this.state !== "starting") {
          socket.destroy();
          resolve(false);
          return;
        }
        this.client = socket;
        this.state = "client";
        socket.on("error", () => {});
        socket.on("close", () => {
          if (this.client !== socket) return;
          this.client = undefined;
          if (this.state === "closed") return;
          this.state = "starting";
          void this.runElection();
        });
        readFrames(socket, line => this.receive(line));
        socket.unref();
        try {
          socket.write(`${JSON.stringify({ t: "hello", scope: this.scope, pid: process.pid, agents: [], v: 1 })}\n`);
        } catch {
          socket.destroy();
          this.degrade();
        }
        resolve(true);
      });
    });
  }

  private accept(socket: Socket): void {
    if (this.state !== "broker") {
      socket.destroy();
      return;
    }
    this.peers.add(socket);
    socket.unref();
    socket.on("error", () => {});
    socket.on("close", () => this.peers.delete(socket));
    readFrames(socket, line => this.receive(line, socket));
  }

  private receive(line: Buffer, sender?: Socket): void {
    const frame = parseFrame(line);
    if (!frame || typeof frame.t !== "string") return;
    if (frame.t === "hello" || frame.t === "watch") return;
    if (frame.t === "bye") {
      sender?.end();
      return;
    }
    if (frame.t !== "bump" || !Array.isArray(frame.mailbox) || !frame.mailbox.every(value => typeof value === "string")) {
      return;
    }

    const mailboxes = frame.mailbox as string[];
    try {
      this.onBump?.(mailboxes);
    } catch {
      // Notification handlers are optimizations and cannot own socket health.
    }
    if (this.state !== "broker") return;
    const encoded = `${line.toString("utf8")}\n`;
    for (const peer of this.peers) {
      if (peer === sender) continue;
      try {
        peer.write(encoded);
      } catch {
        peer.destroy();
      }
    }
  }

  private sendBump(mailboxes: readonly string[]): void {
    const frame = encodeBump(mailboxes);
    if (!frame) return;
    if (this.state === "client" && this.client) {
      try {
        this.client.write(frame);
      } catch {
        this.client.destroy();
        this.degrade();
      }
      return;
    }
    if (this.state !== "broker") return;
    for (const peer of this.peers) {
      try {
        peer.write(frame);
      } catch {
        peer.destroy();
      }
    }
  }

  private runElection(): Promise<void> {
    return this.elect().catch(() => {
      this.degrade();
    });
  }

  private degrade(): void {
    if (this.state === "closed") return;
    this.state = "degraded";
    this.everDegraded = true;
    this.client?.destroy();
    this.client = undefined;
    for (const peer of this.peers) peer.destroy();
    this.peers.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // There is nothing left to release when listen never succeeded.
      }
      this.server = undefined;
    }
  }

  private unlinkPath(): void {
    if (process.platform === "win32") return;
    try {
      unlinkSync(this.path);
    } catch {
      // A leftover advisory path is handled by the next election; polling remains correct.
    }
  }
}
