/**
 * Real extension fixture standing in for `@furbyhaxx/pi-background-jobs` in the
 * e2e runner: it registers the exact four-tool family (`bash` override plus the
 * job tools), so a child's inherited scope can be asserted against real pi-mono
 * rather than a mock. The e2e fabricates the parent registry entry
 * (`getAllTools()`) pointing at this file; the runtime package itself is
 * implemented separately and is deliberately not imported here.
 */
import { Type } from "@sinclair/typebox";

const TOOLS = ["bash", "job_list", "job_output", "job_stop"];

export default function (pi) {
  for (const name of TOOLS) {
    pi.registerTool({
      name,
      label: name,
      description: `Background-jobs family fixture tool ${name} (e2e fixture).`,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: name }] };
      },
    });
  }
}
