import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { editInExternalEditor, getPromptEditor, resolveExternalEditor, setPromptEditor, tokenizeCommand } from "../src/prompt-editor.js";

/** A TUI that records the terminal handover, which is the part that can go wrong. */
function stubTui() {
  const calls: string[] = [];
  const tui = {
    stop: (options?: { preserveScreen?: boolean }) => calls.push(`stop:${options?.preserveScreen ?? false}`),
    start: () => calls.push("start"),
    requestRender: () => calls.push("render"),
  } as unknown as TUI;
  return { tui, calls };
}

describe("prompt editor command", () => {
  it("falls back to $VISUAL then $EDITOR when nothing is configured", () => {
    setPromptEditor(undefined);
    expect(resolveExternalEditor({})).toBeUndefined();
    expect(resolveExternalEditor({ EDITOR: "ed" })).toBe("ed");
    // $VISUAL is the full-screen editor convention, so it leads.
    expect(resolveExternalEditor({ EDITOR: "ed", VISUAL: "vi" })).toBe("vi");
  });

  it("prefers the configured command over the environment", () => {
    setPromptEditor("code --wait");
    try {
      expect(getPromptEditor()).toBe("code --wait");
      expect(resolveExternalEditor({ EDITOR: "ed", VISUAL: "vi" })).toBe("code --wait");
    } finally {
      setPromptEditor(undefined);
    }
  });

  it("treats a blank setting as unset, so the environment fallback still applies", () => {
    setPromptEditor("   ");
    try {
      expect(getPromptEditor()).toBeUndefined();
      expect(resolveExternalEditor({ EDITOR: "ed" })).toBe("ed");
    } finally {
      setPromptEditor(undefined);
    }
  });

  it("splits arguments on whitespace", () => {
    expect(tokenizeCommand("nvim")).toEqual(["nvim"]);
    expect(tokenizeCommand("code --wait")).toEqual(["code", "--wait"]);
    expect(tokenizeCommand("  code   --wait  ")).toEqual(["code", "--wait"]);
  });

  it("keeps a quoted path with spaces as one argument", () => {
    expect(tokenizeCommand('"/opt/My Editor/code" --wait')).toEqual(["/opt/My Editor/code", "--wait"]);
    expect(tokenizeCommand("'/opt/My Editor/code'")).toEqual(["/opt/My Editor/code"]);
  });

  it("does not expand a shell variable — the command comes from a settings file", () => {
    expect(tokenizeCommand("$EDITOR --wait")).toEqual(["$EDITOR", "--wait"]);
  });

  it("keeps an intentionally empty argument", () => {
    expect(tokenizeCommand('code ""')).toEqual(["code", ""]);
  });
});

describe("editing a prompt in an external editor", () => {
  it("returns what the editor saved, and hands the terminal over and back", async () => {
    const { tui, calls } = stubTui();
    // A real child process, so the spawn, the temp file and the read-back are
    // all exercised rather than mocked away.
    const command = `${process.execPath} -e "require('fs').writeFileSync(process.argv[1], 'edited by the editor')"`;

    const result = await editInExternalEditor(tui, command, "original");

    expect(result).toEqual({ status: "edited", content: "edited by the editor" });
    // The renderer must be stopped while the child owns the terminal, and
    // started again afterwards — with the screen preserved, or the editor
    // draws over a blank frame and the user loses their place.
    expect(calls).toEqual(["stop:true", "start", "render"]);
  });

  it("reports failure and restores the terminal when the editor exits non-zero", async () => {
    const { tui, calls } = stubTui();

    // vim, emacs and helix all report "I did not save" this way. Returning the
    // buffer anyway would discard that decision silently.
    const result = await editInExternalEditor(tui, `${process.execPath} -e "process.exit(1)"`, "original");

    expect(result).toEqual({ status: "failed" });
    expect(calls).toContain("start");
  });

  it("reports failure rather than throwing when the command does not exist", async () => {
    const { tui } = stubTui();

    const result = await editInExternalEditor(tui, "definitely-not-an-editor-xyz", "original");

    expect(result).toEqual({ status: "failed" });
  });

  it("fails without launching anything for an empty command", async () => {
    const { tui, calls } = stubTui();
    const stop = vi.spyOn(tui, "stop");

    const result = await editInExternalEditor(tui, "   ", "original");

    expect(result).toEqual({ status: "failed" });
    expect(stop).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
