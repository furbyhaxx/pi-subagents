import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type MessagingScopeMode = "project" | "session";

export interface MessagingScopeOptions {
  originProjectRoot: string;
  mode?: MessagingScopeMode;
  rootSessionId?: string;
  artifactRoot?: string;
  directory?: string;
}

export interface MessagingLocation {
  directory: string;
  databasePath: string;
  scopeKey: string;
  mode: MessagingScopeMode;
}

function ensurePrivateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  return path;
}

export function resolveMessagingLocation(options: MessagingScopeOptions): MessagingLocation {
  const mode = options.mode ?? "project";
  const originRoot = realpathSync(resolve(options.originProjectRoot));
  if (mode === "session" && !options.rootSessionId) {
    throw new Error("Session messaging scope requires a root session id");
  }

  const scopeKey = mode === "project" ? originRoot : `${originRoot}\0${options.rootSessionId}`;
  let directory: string;
  if (options.directory) {
    directory = isAbsolute(options.directory)
      ? options.directory
      : resolve(originRoot, options.directory);
  } else if (mode === "project") {
    const readable = basename(originRoot).replace(/[^a-zA-Z0-9_-]/g, "-") || "project";
    const hash = createHash("sha256").update(originRoot).digest("hex").slice(0, 6);
    directory = join(getAgentDir(), "messaging", `${readable}-${hash}`);
  } else {
    if (!options.artifactRoot) throw new Error("Session messaging scope requires an artifact root");
    directory = join(options.artifactRoot, "messaging");
  }

  const privateDirectory = ensurePrivateDirectory(directory);
  return {
    directory: privateDirectory,
    databasePath: join(privateDirectory, "messaging.sqlite3"),
    scopeKey,
    mode,
  };
}
