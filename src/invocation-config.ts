import { Type } from "@sinclair/typebox";
import type { AgentConfig, IsolationMode, JoinMode, ModelThinkingLevel } from "./types.js";

/**
 * The model-facing `isolation` parameter, shared by the `Agent` tool and the
 * nested delegation tool so the two cannot drift.
 *
 * Shape matters more than wording here. As a single-value optional literal,
 * models that fill every optional parameter — the transcript on #231 shows one
 * emitting `resume: ""`, `schedule: ""` and `model: "default"` alongside it —
 * had only `"worktree"` available to fill it with, and kept spawning worktrees
 * across three turns while their own reasoning said to omit the field. Every
 * other optional parameter has an inert filler; this one did not. `"off"` is
 * listed first and described as the default so the harmless value is the
 * obvious one to reach for.
 *
 * The wording tracks Claude Code's own `isolation` parameter, whose phrasing
 * models have the most exposure to: one description on the union rather than
 * per-value ones, opening "Isolation mode.", then a sentence per value in
 * schema order, each with its caveats in a trailing parenthetical. Two clauses
 * are ours, because our shape is not theirs — `"off"` has no counterpart there
 * (their enum is `worktree | remote`, so both of their values do something),
 * and neither does the uncommitted-work warning, which is the specific trap
 * #231 fell into. Deliberately absent is any "only use a worktree when…"
 * restriction: Claude Code's `Agent` tool states the capability and stops, and
 * a second legal value is what lets a model decline one, not being told to.
 */
export const WORKTREE_BRANCH_REQUIRED_ERROR = 'Worktree isolation requires an explicit branch; pass branch: "feat/<slug>" (a conventional-commit-style name).';

const isolationParamShape = {
  branch: Type.Optional(Type.String({
    minLength: 1,
    description: 'Exact local Git branch, e.g. "feat/x". Implies worktree isolation. Reuses its existing linked worktree or creates one; a missing branch starts at the caller\'s HEAD. This is a reusable named workspace; the agent commits on it, and nothing is pushed, merged, reset, stashed, cleaned, or removed for you. Reuses files, not conversation. Cannot combine with resume or isolation "off". Fails when worktrees are disabled or the branch is busy.',
  })),
  isolation: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("worktree")], {
      description:
        'Isolation mode. Default "off" unless branch is supplied. "off" runs in the current checkout. "worktree" requires an explicit branch such as "feat/<slug>" (a conventional-commit-style name); it creates or reuses a retained linked worktree on that exact local branch. Completion reports its path and change state. The agent is told to commit logical changes unless its task says otherwise. The extension never pushes, merges, resets, stashes, cleans, or removes anything, and commits on its own only when worktreeAutoCommit is enabled. The orchestrating agent must review the branch and explicitly either integrate it and then remove the worktree, or discard and remove it. New worktrees cannot see uncommitted or staged changes in the caller; reused worktrees keep their existing changes.',
    }),
  ),
};

/**
 * Build the `isolation` parameter for a tool schema, or nothing when the
 * project disabled worktrees (`worktreeIsolation: false`).
 *
 * Dropping the field beats advertising a capability the project disabled. The
 * setting is for a project whose model passes `"worktree"` on *every* call, so
 * a per-result disablement note would be noise. Cached tool requests, agent
 * files, schedules and RPC calls still reach runtime validation and fail rather
 * than silently running in the shared checkout.
 *
 * Like `scheduleParam`, this is read once at tool registration — flipping the
 * setting needs a new pi session for the schema to change.
 */
export function isolationParam(enabled: boolean): Partial<typeof isolationParamShape> {
  return enabled ? isolationParamShape : {};
}

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  /**
   * Untyped on purpose. Both tool schemas now build this field conditionally
   * and spread it, which erases TypeBox's literal inference to `unknown` (the
   * `schedule` param has the same shape). The resolver below narrows by
   * comparison rather than trusting the declaration, which also makes it safe
   * for the cross-extension RPC path, where options arrive unvalidated.
   */
  isolation?: unknown;
  branch?: unknown;
}

/** Branch requests never silently degrade into work in the caller's checkout. */
export function resolveBranch(
  branch: unknown,
  isolation: unknown,
  agentIsolation: IsolationMode | undefined,
  worktreeAllowed: boolean,
): string | undefined {
  if (branch === undefined) return undefined;
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("branch must be a non-empty exact local Git branch name.");
  }
  if (!worktreeAllowed) throw new Error("Cannot select a branch: worktree isolation is disabled.");
  if (isolation === "off" || agentIsolation === "off") {
    throw new Error('branch cannot be combined with isolation: "off" (including agent frontmatter).');
  }
  return branch;
}

interface ResolveOptions {
  /** Whether worktree isolation is permitted at all. Defaults to allowed. */
  worktreeAllowed?: boolean;
  /**
   * What an unqualified spawn means — neither the call nor the agent file said.
   *
   * Top-level callers pass the `backgroundByDefault` setting (default `true`,
   * following Claude Code). Nested callers pass `false` unconditionally: a
   * detached child is killed by `abortOwnedChildren` when its parent settles
   * and has no notification path of its own, so backgrounding one loses its
   * work. Both call sites pass it explicitly; the `false` fallback only covers
   * a caller that supplies no options at all, which in-tree means tests.
   */
  defaultRunInBackground?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  opts?: ResolveOptions,
): {
  /** First effective model input, retained for existing display/error paths. */
  modelInput?: string;
  /** Ordered configured inputs; explicit caller model replaces this with one item. */
  modelInputs?: string[];
  modelFromParams: boolean;
  thinking?: ModelThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
  branch?: string;
  /**
   * Caller parameters an agent file's frontmatter outranked, so the surfaces can
   * say "(asked X)" instead of presenting the effective value as the requested
   * one (#182). Populated only where both sides named something and they
   * disagree — a caller who asked for what they got was still honored.
   *
   * `max_turns` is deliberately absent: no surface renders a requested-vs-
   * effective turn limit, so recording one would be dead data.
   */
  overridden?: { thinking?: ModelThinkingLevel; model?: string };
} {
  // Precedence first, collapse second — reversing these loses the veto, since
  // an agent file's "off" only outranks a caller's "worktree" while it is still
  // a value. Everything downstream then sees "worktree" or nothing at all.
  const branch = resolveBranch(params.branch, params.isolation, agentConfig?.isolation, opts?.worktreeAllowed !== false);
  const requested = agentConfig?.isolation ?? params.isolation;
  if (requested === "worktree" && branch === undefined) {
    throw new Error(WORKTREE_BRANCH_REQUIRED_ERROR);
  }
  const isolation = branch !== undefined || (requested === "worktree" && opts?.worktreeAllowed !== false)
    ? "worktree" : undefined;

  const overriddenThinking = agentConfig?.thinking != null && params.thinking != null
    && agentConfig.thinking !== params.thinking
    ? params.thinking as ModelThinkingLevel
    : undefined;
  const modelInputs = params.model !== undefined
    ? [params.model]
    : agentConfig?.models;

  return {
    modelInput: modelInputs?.[0],
    modelInputs,
    modelFromParams: params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ModelThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? opts?.defaultRunInBackground ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation,
    branch,
    // Undefined rather than an empty object when nothing was overridden: callers
    // spread this into the invocation snapshot, and an always-present key would
    // put `requestedThinking: undefined` on every record.
    overridden: overriddenThinking
      ? { thinking: overriddenThinking }
      : undefined,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
