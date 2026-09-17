import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readForeignTranscriptTail } from "../src/messaging/transcript-tail.js";

describe("readForeignTranscriptTail", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "messaging-tail-test-"));
    path = join(directory, "session.jsonl");
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("reads complete JSON objects without changing file bytes or timestamps", async () => {
    const content = '{"type":"message","text":"old format"}\n{"type":"custom","data":{"n":1}}\n';
    writeFileSync(path, content);
    const before = statSync(path);

    const result = await readForeignTranscriptTail(path);

    expect(result).toEqual({
      ok: true,
      lines: ['{"type":"message","text":"old format"}', '{"type":"custom","data":{"n":1}}'],
      truncated: false,
      skippedLines: 0,
    });
    expect(statSync(path)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
  });

  it("does not expose a partial record until its newline arrives", async () => {
    writeFileSync(path, '{"n":1}\n{"n":2}');
    expect(await readForeignTranscriptTail(path)).toMatchObject({ ok: true, lines: ['{"n":1}'], truncated: true });

    appendFileSync(path, "\n");
    expect(await readForeignTranscriptTail(path)).toMatchObject({ ok: true, lines: ['{"n":1}', '{"n":2}'] });
  });

  it("bounds bytes, lines, and records while counting malformed complete lines", async () => {
    const lines = ["not json", JSON.stringify({ huge: "x".repeat(33 * 1024) })];
    for (let index = 0; index < 300; index++) lines.push(JSON.stringify({ index, text: "y".repeat(900) }));
    writeFileSync(path, `${lines.join("\n")}\n`);

    const result = await readForeignTranscriptTail(path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toHaveLength(200);
    expect(Buffer.byteLength(result.lines.join("\n"))).toBeLessThanOrEqual(256 * 1024);
    expect(result.lines.at(-1)).toContain('"index":299');
    expect(result.truncated).toBe(true);
  });

  it("sanitizes terminal controls and recovers after replacement or truncation", async () => {
    writeFileSync(path, `${JSON.stringify({ text: "safe" })}\n`);
    truncateSync(path, 0);
    writeFileSync(path, '{"text":"next\\u001b[31m"}\n');

    const result = await readForeignTranscriptTail(path);

    expect(result).toMatchObject({ ok: true, lines: ['{"text":"next\\u001b[31m"}'] });
  });

  it("reports missing files and an already-aborted read", async () => {
    await expect(readForeignTranscriptTail(path)).resolves.toMatchObject({ ok: false, reason: "missing" });
    writeFileSync(path, '{"n":1}\n');
    const abort = new AbortController();
    abort.abort();
    await expect(readForeignTranscriptTail(path, abort.signal)).resolves.toMatchObject({ ok: false, reason: "aborted" });
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO promptly without waiting for a writer", () => {
    const fixture = join(directory, "read-fifo.mjs");
    const sourceUrl = pathToFileURL(join(process.cwd(), "src", "messaging", "transcript-tail.ts")).href;
    writeFileSync(fixture, [
      `import { readForeignTranscriptTail } from ${JSON.stringify(sourceUrl)};`,
      "const result = await readForeignTranscriptTail(process.argv[2]);",
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n"));
    execFileSync("mkfifo", [path], { stdio: "pipe" });

    const stdout = execFileSync(process.execPath, ["--experimental-strip-types", fixture, path], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1_000,
    });

    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      reason: "not-file",
      message: "Transcript path is not a regular file",
    });
  });
});
