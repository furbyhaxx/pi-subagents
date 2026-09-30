/**
 * prompt-editor.ts — the command that edits an agent's system prompt outside
 * the TUI, and the launch itself.
 *
 * Only ever handed the prompt BODY. The frontmatter is edited field by field
 * in the definition editor, so an external editor is a text editor pointed at
 * prose — not a second, unchecked way to rewrite the YAML.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";

let configured: string | undefined;

/** The `promptEditor` setting, or undefined to fall back to the environment. */
export function getPromptEditor(): string | undefined {
  return configured;
}

export function setPromptEditor(command: string | undefined): void {
  configured = command?.trim() || undefined;
}

/**
 * The editor to launch: the setting first, then `$VISUAL`, then `$EDITOR`.
 * `$VISUAL` leads because that is the variable for a full-screen interactive
 * editor, and `$EDITOR` is conventionally the line editor.
 *
 * Undefined means the caller falls back to the built-in inline editor rather
 * than failing.
 */
export function resolveExternalEditor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (configured) return configured;
  return env.VISUAL?.trim() || env.EDITOR?.trim() || undefined;
}

/**
 * Split a command string into argv, honouring single and double quotes.
 *
 * Not a shell — nothing here is expanded, and nothing should be. The command
 * comes from a settings file, so `$HOME` in it stays literal; what a user
 * needs is a path with a space in it (`"/opt/My Editor/code" --wait`), which a
 * naive `split(" ")` turns into two arguments.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
    }
  }
  if (started || current) tokens.push(current);
  return tokens;
}

export type ExternalEditResult =
  | { status: "edited"; content: string }
  | { status: "failed" };

/**
 * Edit `content` in an external editor and return what it was saved as.
 *
 * The terminal handover is the caller's job: this runs an interactive editor on
 * the same tty the TUI owns, so the caller must stop the renderer first and
 * start it again after. `tui.stop({ preserveScreen: true })` leaves the last
 * frame in place for the editor to draw over, which is what makes the handoff
 * look like a handoff instead of a flicker.
 */
export async function editInExternalEditor(tui: TUI, command: string, content: string): Promise<ExternalEditResult> {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return { status: "failed" };
  const [editor, ...editorArgs] = tokens;

  const directory = mkdtempSync(join(tmpdir(), "pi-subagents-prompt-"));
  const filePath = join(directory, "prompt.md");
  try {
    writeFileSync(filePath, content, "utf-8");
    process.stdout.write(`Launching external editor: ${command}\nPi resumes when it exits.\n`);

    tui.stop({ preserveScreen: true });
    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve) => {
        // Not spawnSync: on Windows a synchronous child call keeps libuv's
        // console input read active and races the child for stdin.
        const child = spawn(editor, [...editorArgs, filePath], {
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        child.on("error", () => resolve(null));
        child.on("close", code => resolve(code));
      });
    } finally {
      tui.start();
      tui.requestRender(true);
    }

    // A non-zero exit is how vim, emacs and helix all report "I did not save".
    // Returning the file anyway would silently discard that decision.
    if (exitCode !== 0) return { status: "failed" };
    const edited = readFileSync(filePath, "utf-8");
    return { status: "edited", content: stripBom(edited).replace(/\n$/, "") };
  } catch {
    return { status: "failed" };
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort; a leftover temp dir is not worth failing an edit over.
    }
  }
}

function stripBom(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}
