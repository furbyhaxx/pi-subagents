import { describe, expect, it } from "vitest";
import { AGENT_FIELDS, type AgentFieldValue, applyAgentFields, readAgentFields } from "../src/agent-frontmatter.js";

/**
 * The definition editor's field model. The contract that matters: a form save
 * must not destroy what a hand-authored file contains outside the form, and it
 * must write values the loader in `custom-agents.ts` will read back the same way.
 */
describe("agent frontmatter field model", () => {
  it("reads every declared field off a file and leaves the rest of the body alone", () => {
    const file = [
      "---",
      "name: reviewer",
      "description: Reviews diffs",
      "tools: read, grep",
      "models:",
      "  - anthropic/claude-sonnet-4-6",
      "thinking: high",
      "max_turns: 12",
      "output_transcript: false",
      "---",
      "",
      "You review diffs.",
      "",
    ].join("\n");

    const { values, body } = readAgentFields(file);

    expect(values.name).toBe("reviewer");
    expect(values.description).toBe("Reviews diffs");
    expect(values.tools).toEqual(["read", "grep"]);
    expect(values.models).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(values.thinking).toBe("high");
    expect(values.maxTurns).toBeUndefined();
    expect(values.max_turns).toBe(12);
    expect(values.output_transcript).toBe(false);
    expect(body).toBe("You review diffs.");
  });

  it("distinguishes an absent boolean from a false one", () => {
    const absent = readAgentFields("---\ndescription: x\n---\n\nbody\n");
    const disabled = readAgentFields("---\ndescription: x\noutput_transcript: false\n---\n\nbody\n");

    expect(absent.values.output_transcript).toBeUndefined();
    expect(disabled.values.output_transcript).toBe(false);
  });

  it("reads `model:` as the single-entry form of `models:`", () => {
    expect(readAgentFields("---\nmodel: anthropic/claude-opus-4-6\n---\n\nb\n").values.models)
      .toEqual(["anthropic/claude-opus-4-6"]);
  });

  it("round-trips a field set back to a file the loader agrees with", () => {
    const original = "---\ndescription: before\n---\n\nold body\n";
    const { values } = readAgentFields(original);

    const written = applyAgentFields(original, { ...values, description: "after", max_turns: 5 }, "new body");

    const reread = readAgentFields(written);
    expect(reread.values.description).toBe("after");
    expect(reread.values.max_turns).toBe(5);
    expect(reread.body).toBe("new body");
  });

  it("keeps comments, key order and unknown keys", () => {
    const original = [
      "---",
      "# who this is for",
      "description: before",
      "some_future_field: keep me",
      "prompt_mode: replace",
      "---",
      "",
      "body",
      "",
    ].join("\n");

    const written = applyAgentFields(original, { description: "after" }, "body");

    expect(written).toContain("# who this is for");
    expect(written).toContain("some_future_field: keep me");
    expect(written.indexOf("description")).toBeLessThan(written.indexOf("some_future_field"));
    expect(readAgentFields(written).values.description).toBe("after");
  });

  it("drops a key when its value is undefined, and clears its alias with it", () => {
    const original = "---\nmodel: anthropic/claude-opus-4-6\nthinking: high\n---\n\nbody\n";

    const written = applyAgentFields(original, { models: undefined }, "body");

    expect(written).not.toContain("model:");
    expect(written).toContain("thinking: high");
  });

  it("never writes both model and models, which the loader refuses", () => {
    const original = "---\nmodel: anthropic/claude-opus-4-6\n---\n\nbody\n";

    const written = applyAgentFields(original, { models: ["anthropic/claude-sonnet-4-6"] }, "body");

    expect(written).toContain("models:");
    expect(written).not.toMatch(/^model:/m);
  });

  it("writes tools as a bare CSV, with `none` for an empty list", () => {
    const original = "---\ndescription: x\n---\n\nbody\n";

    expect(applyAgentFields(original, { tools: ["read", "bash"] }, "body")).toContain("tools: read, bash");
    expect(applyAgentFields(original, { tools: [] }, "body")).toContain("tools: none");
    expect(applyAgentFields(original, { tools: undefined }, "body")).not.toContain("tools:");
  });

  it("writes an inherit field as a boolean or a CSV, never a sequence", () => {
    const original = "---\ndescription: x\n---\n\nbody\n";

    expect(applyAgentFields(original, { extensions: false }, "body")).toContain("extensions: false");
    expect(applyAgentFields(original, { skills: ["a", "b"] }, "body")).toContain("skills: a, b");
  });

  it("drops an emptied list field rather than writing an empty scalar", () => {
    const original = "---\ndescription: x\nexclude_extensions: a, b\n---\n\nbody\n";

    const written = applyAgentFields(original, { exclude_extensions: [] }, "body");

    // `key: ""` would parse back as absent anyway, so it is only noise in the
    // user's file — and it survives a save as a line they never wrote.
    expect(written).not.toContain("exclude_extensions");
    expect(readAgentFields(written).values.exclude_extensions).toBeUndefined();
  });

  it("creates a frontmatter block for a file that has none", () => {
    const written = applyAgentFields("just a body\n", { description: "new" }, "just a body");

    expect(written.startsWith("---\n")).toBe(true);
    expect(readAgentFields(written).values.description).toBe("new");
    expect(readAgentFields(written).body).toBe("just a body");
  });

  it("preserves CRLF line endings and a leading BOM", () => {
    const original = "\uFEFF---\r\ndescription: before\r\ncolor: red\r\n---\r\n\r\nbody\r\n";

    const written = applyAgentFields(original, { description: "after" }, "body");

    expect(written.startsWith("\uFEFF")).toBe(true);
    // The inner block too, not just the fences: a file that comes back with
    // CRLF fences around LF lines is worse than one that normalized.
    expect(written).toBe("\uFEFF---\r\ndescription: after\r\ncolor: red\r\n---\r\n\r\nbody\r\n");
    expect(readAgentFields(written).values.description).toBe("after");
  });

  it("replaces an unparseable block rather than refusing to save", () => {
    const original = "---\ndescription: [unclosed\n---\n\nbody\n";

    const written = applyAgentFields(original, { description: "fixed" }, "body");

    expect(readAgentFields(written).values.description).toBe("fixed");
  });

  it("declares each key once, and every field round-trips through the form", () => {
    const keys = AGENT_FIELDS.map(field => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    // The singular spelling is an alias, never a field of its own.
    expect(keys).not.toContain("model");
    expect(keys).not.toContain("inherit_extensions");

    // Every declared field must be writable AND readable, or the form shows a
    // control whose value silently disappears on save. One value per kind, so
    // the loop covers all of them without a fixture per field.
    const samples: Record<string, AgentFieldValue> = {
      text: "reviewer",
      color: "red",
      boolean: true,
      integer: 7,
      choice: AGENT_FIELDS.find(f => f.kind === "choice" && f.key !== "prompt_mode")?.options?.[0] ?? "append",
      tools: ["read", "bash"],
      inherit: ["a", "b"],
      list: ["x", "y"],
      subagents: ["other"],
      models: ["anthropic/claude-sonnet-4-6"],
    };
    for (const field of AGENT_FIELDS) {
      const written = applyAgentFields("---\ndescription: d\n---\n\nbody\n", { [field.key]: samples[field.kind] }, "body");
      expect(readAgentFields(written).values[field.key], `field ${field.key}`).toEqual(samples[field.kind]);
    }
  });
});
