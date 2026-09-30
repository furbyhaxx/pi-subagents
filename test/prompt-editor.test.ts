import { describe, expect, it } from "vitest";
import { getPromptEditor, resolveExternalEditor, setPromptEditor, tokenizeCommand } from "../src/prompt-editor.js";

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
