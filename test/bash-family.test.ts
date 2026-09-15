/**
 * bash-family.test.ts — source-provenance recognition of the background-jobs
 * tool family.
 *
 * The point of the resolver is what it REJECTS: a child only inherits a bash
 * override when the parent's registry proves the exact four-tool family on one
 * non-builtin path. A wrapper or sandbox that overrides `bash` alone must stay
 * unrecognized, and a partial family (a job tool from elsewhere) is not one.
 */
import { describe, expect, it } from "vitest";
import { BASH_FAMILY_TOOL_NAMES, bashOverridePath, resolveBashFamily, type ToolSource } from "../src/bash-family.js";

const FAMILY_PATH = "/ext/pi-background-jobs/src/index.ts";

/** A complete family, with each field overridable per tool. */
function familyTools(mutate: (tool: ToolSource) => ToolSource = (tool) => tool): ToolSource[] {
  return BASH_FAMILY_TOOL_NAMES.map((name) =>
    mutate({ name, sourceInfo: { path: FAMILY_PATH, source: "extension" } }),
  );
}

describe("resolveBashFamily", () => {
  it("recognizes the complete family on one non-builtin source path", () => {
    expect(resolveBashFamily(familyTools())).toEqual({
      path: FAMILY_PATH,
      toolNames: ["bash", "job_list", "job_output", "job_stop"],
    });
  });

  it("ignores tools from the same extension that are not family members", () => {
    // Propagation is bounded by the family contract, not by "everything the
    // extension happens to register".
    const tools = [...familyTools(), { name: "unrelated_tool", sourceInfo: { path: FAMILY_PATH, source: "extension" } }];
    expect(resolveBashFamily(tools)?.toolNames).toEqual(["bash", "job_list", "job_output", "job_stop"]);
  });

  it("rejects a built-in bash even when job tools exist", () => {
    const tools = familyTools((tool) => tool.name === "bash"
      ? { ...tool, sourceInfo: { path: FAMILY_PATH, source: "builtin" } }
      : tool);
    expect(resolveBashFamily(tools)).toBeUndefined();
  });

  it("rejects a partial family — every job tool is required", () => {
    for (const missing of ["job_list", "job_output", "job_stop"]) {
      const tools = familyTools().filter((tool) => tool.name !== missing);
      expect(resolveBashFamily(tools), `missing ${missing}`).toBeUndefined();
    }
  });

  it("rejects a job tool registered by a different extension path", () => {
    const tools = familyTools((tool) => tool.name === "job_stop"
      ? { ...tool, sourceInfo: { path: "/ext/other/index.ts", source: "extension" } }
      : tool);
    expect(resolveBashFamily(tools)).toBeUndefined();
  });

  it("rejects a builtin job tool even on the family path", () => {
    // Same paths, but one member is not the extension's own registration.
    const tools = familyTools((tool) => tool.name === "job_list"
      ? { ...tool, sourceInfo: { path: FAMILY_PATH, source: "builtin" } }
      : tool);
    expect(resolveBashFamily(tools)).toBeUndefined();
  });

  it("rejects a relative or empty source path", () => {
    expect(resolveBashFamily(familyTools((tool) => ({ ...tool, sourceInfo: { path: "ext/index.ts", source: "extension" } })))).toBeUndefined();
    expect(resolveBashFamily(familyTools((tool) => ({ ...tool, sourceInfo: { path: "", source: "extension" } })))).toBeUndefined();
    expect(resolveBashFamily(familyTools((tool) => ({ ...tool, sourceInfo: undefined })))).toBeUndefined();
  });

  it("rejects a bash override with no job tools at all", () => {
    const tools = [{ name: "bash", sourceInfo: { path: "/ext/wrapper/index.ts", source: "extension" } }];
    expect(resolveBashFamily(tools)).toBeUndefined();
  });

  it("returns undefined for an absent or empty registry", () => {
    expect(resolveBashFamily(undefined)).toBeUndefined();
    expect(resolveBashFamily([])).toBeUndefined();
  });
});

describe("bashOverridePath", () => {
  it("returns the non-builtin bash path", () => {
    expect(bashOverridePath(familyTools())).toBe(FAMILY_PATH);
  });

  it("returns undefined for a built-in bash", () => {
    const tools = familyTools((tool) => tool.name === "bash"
      ? { ...tool, sourceInfo: { path: FAMILY_PATH, source: "builtin" } }
      : tool);
    expect(bashOverridePath(tools)).toBeUndefined();
  });

  it("returns undefined when there is no bash tool", () => {
    expect(bashOverridePath([{ name: "read", sourceInfo: { path: FAMILY_PATH, source: "extension" } }])).toBeUndefined();
  });
});
