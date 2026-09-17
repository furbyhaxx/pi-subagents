import { constants, type Stats } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";

const MAX_BYTES = 256 * 1024;
const MAX_LINES = 200;
const MAX_RECORD_BYTES = 32 * 1024;

export type ForeignTranscriptTailResult =
  | { ok: true; lines: string[]; truncated: boolean; skippedLines: number }
  | { ok: false; reason: "missing" | "unreadable" | "not-file" | "changed" | "aborted"; message: string };

function failure(
  reason: "missing" | "unreadable" | "not-file" | "changed" | "aborted",
  message: string,
): ForeignTranscriptTailResult {
  return { ok: false, reason, message };
}

function abortResult(signal: AbortSignal | undefined): ForeignTranscriptTailResult | undefined {
  return signal?.aborted ? failure("aborted", "Transcript read was aborted") : undefined;
}

function errorResult(error: unknown): ForeignTranscriptTailResult {
  const code = error instanceof Error && "code" in error
    ? String((error as Error & { code?: unknown }).code)
    : undefined;
  if (code === "ENOENT") return failure("missing", "Transcript file does not exist");
  return failure("unreadable", error instanceof Error ? error.message : String(error));
}

function sanitize(line: string): string {
  return line.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Read a bounded, read-only JSONL tail without opening it as a Pi session. */
export async function readForeignTranscriptTail(
  path: string,
  signal?: AbortSignal,
): Promise<ForeignTranscriptTailResult> {
  const alreadyAborted = abortResult(signal);
  if (alreadyAborted) return alreadyAborted;

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return abortResult(signal) ?? errorResult(error);
  }

  try {
    const afterOpen = abortResult(signal);
    if (afterOpen) return afterOpen;
    const initial = await handle.stat();
    const afterInitial = abortResult(signal);
    if (afterInitial) return afterInitial;
    if (!initial.isFile()) return failure("not-file", "Transcript path is not a regular file");
    if (initial.size === 0) return { ok: true, lines: [], truncated: false, skippedLines: 0 };

    const length = Math.min(MAX_BYTES, initial.size);
    const position = initial.size - length;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const aborted = abortResult(signal);
      if (aborted) return aborted;
      const result = await handle.read(buffer, offset, length - offset, position + offset);
      const afterRead = abortResult(signal);
      if (afterRead) return afterRead;
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }

    const handleAfter = await handle.stat();
    const afterHandleStat = abortResult(signal);
    if (afterHandleStat) return afterHandleStat;
    let pathAfter: Stats;
    try {
      pathAfter = await stat(path);
    } catch {
      return abortResult(signal) ?? failure("changed", "Transcript file changed while it was being read");
    }
    const afterStats = abortResult(signal);
    if (afterStats) return afterStats;
    if (handleAfter.dev !== initial.dev || handleAfter.ino !== initial.ino
      || pathAfter.dev !== initial.dev || pathAfter.ino !== initial.ino
      || handleAfter.size < initial.size || pathAfter.size < initial.size) {
      return failure("changed", "Transcript file changed while it was being read");
    }

    let data = buffer.subarray(0, offset);
    let truncated = position > 0 || offset < length;
    if (position > 0) {
      const firstNewline = data.indexOf(0x0a);
      if (firstNewline < 0) return { ok: true, lines: [], truncated: true, skippedLines: 0 };
      data = data.subarray(firstNewline + 1);
    }
    if (data.byteLength > 0 && data[data.byteLength - 1] !== 0x0a) {
      const lastNewline = data.lastIndexOf(0x0a);
      data = lastNewline < 0 ? Buffer.alloc(0) : data.subarray(0, lastNewline + 1);
      truncated = true;
    }

    const lines: string[] = [];
    let skippedLines = 0;
    let start = 0;
    for (let index = 0; index < data.byteLength; index++) {
      if (data[index] !== 0x0a) continue;
      let record = data.subarray(start, index);
      if (record.byteLength > 0 && record[record.byteLength - 1] === 0x0d) record = record.subarray(0, -1);
      start = index + 1;
      if (record.byteLength > MAX_RECORD_BYTES) {
        skippedLines++;
        continue;
      }
      const line = record.toString("utf8");
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          skippedLines++;
          continue;
        }
      } catch {
        skippedLines++;
        continue;
      }
      lines.push(sanitize(line));
    }
    if (lines.length > MAX_LINES) {
      lines.splice(0, lines.length - MAX_LINES);
      truncated = true;
    }
    return { ok: true, lines, truncated, skippedLines };
  } catch (error) {
    return abortResult(signal) ?? errorResult(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
