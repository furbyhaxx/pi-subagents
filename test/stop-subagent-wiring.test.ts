import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

describe("stop_subagent tool", () => {
  let hermetic: ReturnType<typeof hermeticDir> | undefined;

  afterEach(() => {
    hermetic?.restore();
    hermetic = undefined;
    vi.clearAllMocks();
  });

  it("stops without deleting the record, is idempotent, and allows resume", async () => {
    hermetic = hermeticDir({
      settings: { schedulingEnabled: false, workflowsEnabled: false },
      agentFiles: { worker: "---\ndescription: Worker\n---\n\nWork." },
    });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const session = {
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      messages: [],
      getActiveToolNames: vi.fn(() => []),
      steer: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session as never);
      return new Promise(resolve => {
        options.signal?.addEventListener("abort", () => resolve({
          responseText: "stopped output",
          session: session as never,
          aborted: true,
          steered: false,
        } as never));
      });
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed output" } as never);

    const spawned = await tools.get("Agent").execute("tc-spawn", {
      prompt: "first",
      description: "stop test",
      name: "stop-alias",
      subagent_type: "worker",
      run_in_background: true,
    }, undefined, undefined, ctx({ cwd: hermetic.dir }));
    expect(textOf(spawned)).toContain("Agent ID:");
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    if (!id) throw new Error("spawn result did not include an agent ID");

    const stopped = await tools.get("stop_subagent").execute(
      "tc-stop", { agent_id: "stop-alias" }, undefined, undefined, ctx({ cwd: hermetic.dir }),
    );
    expect(textOf(stopped)).toContain(`Agent ${id}: stopped`);
    expect(textOf(stopped)).toContain(`Agent({resume: "${id}"})`);

    const repeated = await tools.get("stop_subagent").execute(
      "tc-stop-again", { agent_id: id }, undefined, undefined, ctx({ cwd: hermetic.dir }),
    );
    expect(textOf(repeated)).toContain(`Agent ${id}: stopped`);

    const result = await tools.get("get_subagent_result").execute(
      "tc-result", { agent_id: id }, undefined, undefined, ctx({ cwd: hermetic.dir }),
    );
    expect(textOf(result)).toContain("Status: stopped");

    const resumed = await tools.get("Agent").execute("tc-resume", {
      prompt: "continue",
      description: "resume test",
      subagent_type: "worker",
      resume: id,
      run_in_background: true,
    }, undefined, undefined, ctx({ cwd: hermetic.dir }));
    expect(textOf(resumed)).toContain("resumed in background");
    expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "continue", expect.anything());

    await lifecycle.get("session_shutdown")?.();
  });
});
