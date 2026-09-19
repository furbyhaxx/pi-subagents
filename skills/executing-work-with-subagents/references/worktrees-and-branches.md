# Worktrees and branches

Three places delegated work can happen: the shared checkout, a disposable
worktree, or a retained branch workspace. Picking wrong costs either safety or
time.

## Contents

- [Choosing](#choosing)
- [Disposable worktrees](#disposable-worktrees)
- [Retained branch workspaces](#retained-branch-workspaces)
- [The lease: one writer per branch](#the-lease-one-writer-per-branch)
- [What a worktree does not contain](#what-a-worktree-does-not-contain)
- [Briefing an agent that runs in a workspace](#briefing-an-agent-that-runs-in-a-workspace)
- [Storage and cleanup](#storage-and-cleanup)
- [Turning isolation off](#turning-isolation-off)
- [Failure modes](#failure-modes)

## Choosing

| Mode | Call | Use when | Aftermath |
|---|---|---|---|
| Shared checkout | omit both | Read-only work, or exactly one writer | Nothing isolated; your tree is edited directly |
| Disposable | `isolation: "worktree"` | Speculative writes, risky refactors, parallel writers you may discard | Worktree removed; changes preserved on a `pi-agent-<id>` branch if any |
| Retained | `branch: "feat/x"` | Multi-step work on one line, reused across several agents | Workspace, branch, index and files all remain; nothing auto-commits |

Isolation is not free: a copy costs setup time and disk per agent. Reach for it
when parallel edits would actually collide, when you might want to throw the work
away, or when the main checkout must stay usable while an agent works.

## Disposable worktrees

`isolation: "worktree"` gives the agent a full isolated copy of the repository at
a detached HEAD.

- **No changes:** the worktree is removed, no branch.
- **Changes:** they are committed to a new `pi-agent-<id>` branch and the result
  names the branch and the `git merge` command. The worktree path is gone.
- **The agent committed its own work:** the branch is created at its HEAD, with
  any leftovers committed on top.

The preservation commit uses `--no-verify`, so local pre-commit hooks cannot
block it; the commit is local-only and never pushed.

If the worktree cannot be created (not a git repo, no commits, `git worktree add`
failed), the `Agent` call **fails**. Isolation is a strict guarantee, not a hint,
and the failure is reported as a failed tool call rather than as an agent that
ran and complained.

It is a directive, not a sandbox: the agent's system prompt tells it to work only
in the copy, but an agent with `bash` can `cd` out.

## Retained branch workspaces

```text
Agent({
  subagent_type: "general-purpose",
  description: "Implement feature X",
  branch: "feat/x",
  prompt: "Implement src/x.ts. Run npm test. Do not commit.",
})
```

`branch` implies worktree isolation and names an **exact local branch** —
validated by Git, not a tag, revision shortcut or arbitrary commit-ish. There is
no fetch and no remote-branch guessing.

- Missing local branch → created at the caller's resolved HEAD.
- Existing local branch without a worktree → a copy at its tip.
- Branch already checked out in a linked worktree → that registered path is
  reused, **including its staged, unstaged and untracked files**, even if it sits
  outside the configured container.
- Reusing the main or orchestrating checkout is refused.

Retained means retained: on success, failure, cancellation and shutdown, the
extension never commits, merges, resets, stashes, cleans or removes the
workspace. Integration is yours.

Sequential calls on the same branch share **files, not conversation**:

```text
Agent({ branch: "feat/x", prompt: "Implement …", name: "impl" })
Agent({ branch: "feat/x", prompt: "Review src/x.ts. Do not edit.", ... })   # after the first settles
```

For conversation continuity use `resume` instead — and note `resume` cannot be
combined with `branch`; it reacquires and validates the original scope itself,
refusing a missing path or a changed checked-out branch rather than silently
falling back to the parent directory.

## The lease: one writer per branch

One extension-managed writer holds a cross-process repository/branch lease
through execution and through any workflow `gate`. Contention **fails fast**
rather than queueing: steer or resume the owning agent, or use another branch.

Consequences for scheduling:

- Never point two parallel agents at the same branch. That is the one collision
  the extension will refuse for you — treat the refusal as a design error, not a
  retry condition.
- Nested children that inherit their parent's cwd intentionally share its
  workspace; explicitly reacquiring the same branch does not bypass the lease.
- Human processes (your own shell, an editor) are outside the guard.
- A `branch` call is revalidated when a schedule fires, and overlapping writers
  are refused rather than queued.

## What a worktree does not contain

**A newly created worktree does not copy the caller's uncommitted or staged
changes.** It contains committed files only.

The consequence people trip over: you cannot review your own working-tree or
staged diff from inside a fresh worktree. An agent asked to "review my changes"
there sees a clean tree and reports nothing wrong. Review diffs in the shared
checkout, or commit first.

Reusing an existing named worktree is different — that worktree's own changes are
exposed, because they are its files.

## Briefing an agent that runs in a workspace

The harness already injects a `<worktree_scope>` block naming the repository,
worktree root, working directory, branch or detached state, whether it was
created or reused, whether it started dirty, and whether it is retained. It also
already tells the agent to work in the copy, map paths into it, preserve
pre-existing changes, not switch branches or create worktrees, and report
worktree-relative paths.

So your brief should add only what is task-specific:

- **Use repository-relative paths.** Absolute paths from the parent checkout are
  the main reason agents wander out of the copy.
- **Pass `branch` as an argument.** Never ask the agent to create a worktree,
  switch branches or set up git — it will improvise.
- **State the commit policy explicitly.** "Do not commit", or "commit each
  logical change with a conventional message". Retained workspaces auto-commit
  nothing.
- **State the validation**: the command that must pass, run inside the workspace.
- **Say what to preserve** when reusing a workspace that may already be dirty.

## Storage and cleanup

The worktree container is chosen by `worktreeDirectory`:

| Value | Container |
|---|---|
| `{"mode": "session"}` (default) | `<artifact root>/<project>/<session>/worktrees/`, sibling to `tasks/` |
| `{"mode": "project"}` | `<repo root>/.worktrees/` |
| `{"mode": "custom", "path": "..."}` | Absolute, or relative to the origin repository |

A container inside the repository **must already be ignored** — acquisition fails
with an actionable error otherwise, and the extension never edits a tracked
`.gitignore` for you (for project mode, add `/.worktrees/` to
`.git/info/exclude`). Changes apply to future acquisitions only; existing
worktrees are never migrated.

Cleanup interacts with background jobs: a disposable worktree is removed only
after that worktree's background jobs are stopped, and the result lists what was
stopped. If termination cannot be confirmed, the worktree is **retained** and the
failure reported — a tree a live job may still be writing to is never deleted.
Named worktrees are never implicitly stopped and keep their jobs.

Monorepos: with a `cwd` inside a package, the agent works at the equivalent
subdirectory inside the copy, and the preservation branch lands in that
repository. Configuration discovery stays anchored to the initiating project — a
branch's own `.pi` extensions are not loaded.

## Turning isolation off

| Level | How |
|---|---|
| Per call | Omit `isolation` and `branch`, or pass `isolation: "off"` (without `branch`) |
| Per agent | `isolation: off` in frontmatter — authoritative; an explicit caller `branch` then **errors** |
| Per project | `"worktreeIsolation": false` in `subagents.json` — the parameters disappear from the schema next session, and creation is refused on every path including RPC and schedules |

Project-level off is the right call on a repository large enough that a copy
costs real time and disk.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot run with isolation: "worktree"` | Not a git repo, no commits, or `git worktree add` failed | `git init` + one commit, or drop the option |
| Agent reports a clean tree when reviewing "my changes" | Fresh worktree has no uncommitted caller changes | Review in the shared checkout, or commit first |
| Branch request refused as busy | Another agent holds the lease | Steer/resume that agent, or pick another branch |
| Agent edited the main checkout anyway | Absolute parent paths in the brief, or it `cd`'d out | Repository-relative paths; restrict `bash` |
| Worktree still on disk after the run | Retained (named), or a background job could not be confirmed stopped | Remove it yourself after checking jobs |
| Changes vanished | Disposable worktree; they are on the reported `pi-agent-*` branch | `git log --all`, then merge that branch |
| Acquisition fails naming `.gitignore` | Container inside the repo is not ignored | Add the rule to `.git/info/exclude` and retry |
