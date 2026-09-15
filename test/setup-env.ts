/**
 * setup-env.ts — per-test-file sandbox for `PI_CODING_AGENT_SESSION_DIR`.
 *
 * The fixtures isolate `PI_CODING_AGENT_DIR` and `HOME`, but the session-root
 * override is inherited from the developer's shell. Tests that drive a REAL
 * child session (the print-mode e2e suites, the restore-under-override case)
 * then persist that child's JSONL under the live
 * `<PI_CODING_AGENT_SESSION_DIR>/subagents` instead of an isolated directory —
 * a single `npm run check` wrote four figures of test-owned files into a real
 * project session store. Sandboxing the variable per test file keeps the
 * feature exercised (the override is set, and children really write under it)
 * rather than unsetting it for every test.
 *
 * Vitest runs setup files once per test file, before the test module is
 * imported (@vitest/runner's collectTests imports setup files first), so the
 * assignment is already in place for module-level reads and for every
 * `process.env` read a spawned child makes.
 *
 * The assignment is deliberately direct, NOT `vi.stubEnv`: tests call
 * `vi.unstubAllEnvs()` routinely, and a setup-level stub would then be restored
 * to the live value, reopening the leak. With a direct assignment, a test's own
 * `vi.stubEnv` captures the sandbox as its original value and restores that
 * sandbox when it unstubs.
 *
 * Lifetime: one sandbox per test file. `afterAll` is registered first, so with
 * the default `sequence.hooks: "stack"` it runs last and sees the variable
 * either still sandboxed or left behind by a test; it restores the worker's
 * original value and removes the sandbox either way.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const sessionSandbox = mkdtempSync(join(tmpdir(), "pi-subagents-session-dir-"));
process.env.PI_CODING_AGENT_SESSION_DIR = sessionSandbox;

afterAll(() => {
  if (originalSessionDir == null) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
  rmSync(sessionSandbox, { recursive: true, force: true });
});
