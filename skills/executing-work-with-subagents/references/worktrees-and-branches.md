# Worktrees and branches

Three places delegated work can happen: the shared checkout, a retained detached
worktree, or a retained named-branch workspace. Picking wrong costs either safety
or time.

## Contents

- [Choosing](#choosing)
- [Detached worktrees](#detached-worktrees)
- [Named branch workspaces](#named-branch-workspaces)
- [The lease: one writer per branch](#the-lease-one-writer-per-branch)
- [What a worktree does not contain](#what-a-worktree-does-not-contain)
- [Briefing an agent that runs in a workspace](#briefing-an-agent-that-runs-in-a-workspace)
- [Reviewing, integrating and cleaning up](#reviewing-integrating-and-cleaning-up)
- [Storage and settlement](#storage-and-settlement)
- [Turning isolation off](#turning-isolation-off)
- [Failure modes](#failure-modes)

## Choosing

| Mode | Call | Use when | Aftermath |
|---|---|---|---|
| Shared checkout | omit both | Read-only work, or exactly one writer | Nothing isolated; your tree is edited directly |
| Detached | `isolation: "worktree"` | Speculative writes, risky refactors, parallel writers you may discard | Worktree stays detached and retained; nothing auto-commits or removes it |
| Named | `branch: "feat/x"` | Multi-step work on one line, reused across several agents | Workspace, branch, index and files remain; nothing auto-commits |

Isolation is not free: a copy costs setup time and disk per agent. Reach for it
when parallel edits would actually collide, when you might want to throw the work
away, or when the main checkout must stay usable while an agent works.

## Detached worktrees

`isolation: "worktree"` gives the agent a full isolated copy of the repository at
a detached HEAD. Every extension-created worktree is retained after success,
turn-limit wrap-up, abort, stop, failure, cancellation and shutdown. An anonymous
worktree remains detached whether it is clean or changed.

The extension never automatically commits, creates a preservation branch,
merges, resets, stashes, cleans, removes or prunes the worktree. Completion
reports its retained path and whether it has changes. The orchestrating agent
owns the next decision: inspect the tree, choose integration or discard, create a
branch and commit deliberately inside the retained worktree if integration needs
them, then remove and prune the worktree explicitly.

If the worktree cannot be created (not a git repo, no commits, or `git worktree
add` failed), the `Agent` call **fails**. Isolation is a strict guarantee, not a
hint, and the failure is reported as a failed tool call rather than as an agent
that ran and complained. Failures before `git worktree add` create no workspace.
Failures after add during verification still fail the call, but retain and
report the acquired path conservatively.

Isolation is a directive, not a sandbox: the agent's system prompt tells it to
work only in the copy, but an agent with `bash` can `cd` out.

## Named branch workspaces

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

Named worktrees follow the same retention rule as detached worktrees: every
settlement outcome leaves the workspace in place, and the extension performs no
automatic Git mutation or removal. A completion reports the retained path and
change state. Integration and cleanup belong to the orchestrating agent.

Sequential calls on the same branch share **files, not conversation**:

```text
Agent({ branch: "feat/x", prompt: "Implement …", name: "impl" })
Agent({ branch: "feat/x", prompt: "Review src/x.ts. Do not edit.", ... })   # after the first settles
```

For conversation continuity use `resume` instead. `resume` cannot be combined
with `branch`; it reacquires and validates the original scope itself, refusing a
missing path or a changed checked-out branch rather than silently falling back
to the parent directory.

## The lease: one writer per branch

One extension-managed writer holds a cross-process repository/branch lease
through execution, workflow gates and anonymous-worktree background-job
quiescence. Contention **fails fast** rather than queueing: steer or resume the
owning agent, or use another branch. For anonymous worktrees, background jobs
are quiesced before a workflow gate runs, and the gate runs before settlement
and lease release; if quiescence cannot be confirmed, the gate does not run.
Named worktrees skip implicit job control. Retention does not shorten this
ordering.

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

The harness injects a `<worktree_scope>` block naming the repository, worktree
root, working directory, branch or detached state, whether it was created or
reused, whether it started dirty, and that it is retained. It also tells the
agent to work in the copy, map paths into it, preserve pre-existing changes, not
switch branches or create worktrees, and report worktree-relative paths.

So your brief should add only what is task-specific:

- **Use repository-relative paths.** Absolute paths from the parent checkout are
  the main reason agents wander out of the copy.
- **Pass `branch` as an argument.** Never ask the agent to create a worktree,
  switch branches or set up git — it will improvise.
- **State the commit policy explicitly.** "Do not commit", or "commit each
  logical change with a conventional message". The extension auto-commits
  nothing.
- **State the validation**: the command that must pass, run inside the workspace.
- **Say what to preserve** when reusing a workspace that may already be dirty.

## Reviewing, integrating and cleaning up

The extension gets the work *into* a workspace and leaves it there. Nothing
commits, branches, merges, pushes or deletes on your behalf. A run is finished
only when the orchestrating agent has reviewed the retained tree, deliberately
integrated or discarded it, and removed it from disk.

### Find what you have

The completion report is authoritative for the retained path and change state.
Confirm it against Git:

```bash
git worktree list
git -C /path/to/worktree status --short
git -C /path/to/worktree diff --stat
```

For an anonymous run, `git branch --show-current` in the retained tree prints
nothing because the worktree stays detached. A named run reports its exact
branch and retained path.

### Review before you integrate

```bash
git -C /path/to/worktree status
git -C /path/to/worktree diff
git -C /path/to/worktree log --oneline --decorate -10
```

An agent's gate proves only what the gate ran. Inspect staged, unstaged and
untracked files, and re-run the project's own check suite after integration in
the main checkout.

Delegating review is fine: point a read-only reviewer at the retained path. Do
not acquire a *new* worktree to review someone's uncommitted work; a fresh copy
contains committed files only.

### Integrate or discard deliberately

If an anonymous detached worktree should be integrated, create the branch and
commit deliberately **inside that retained worktree**:

```bash
git -C /path/to/worktree switch -c feat/x
git -C /path/to/worktree add -p
git -C /path/to/worktree commit
```

For a named workspace, commit there if needed. Then integrate from the main
checkout rather than trying to check out a branch already held by a linked
worktree:

```bash
cd /path/to/main/checkout
git merge --no-ff feat/x
npm run check
```

Cherry-pick, rebase or squash are valid deliberate alternatives. Integrate one
workspace at a time and re-run checks after each; textually clean merges can
still be semantically incompatible.

If the work is unwanted, inspect it first, then discard it deliberately. Do not
mistake a clean completion summary for permission to delete a dirty tree.

### Then clean up

After integration or an explicit discard decision:

```bash
git worktree remove /path/to/worktree    # refuses if the tree is dirty
git worktree prune                       # drop stale administrative records
git branch -d feat/x                     # only when the branch is no longer needed
```

`git worktree remove` or `git branch -d` refusing is a safety signal. Review the
remaining work before considering force; the extension will not do that for you.

| Situation | What it means | Do |
|---|---|---|
| `remove` refuses: tree is dirty | Uncommitted or untracked files remain | Review; commit for integration or discard deliberately |
| An agent still owns the branch lease | A run is live in that workspace | Let it finish, or stop it; then re-check |
| Background jobs are running in the tree | Something may still be writing there | Stop them (`job_list`, `job_stop`) prior to manual removal |
| The directory is gone but `worktree list` still shows it | Stale administrative record | `git worktree prune` |

### Checklist

1. Read the completion's retained path and change state.
2. Confirm with `git worktree list` and `git -C <path> status`.
3. Read staged, unstaged, untracked and committed changes.
4. Choose integration or discard explicitly.
5. If integrating a detached tree, create its branch/commit deliberately there.
6. Integrate from the main checkout and run the project's checks.
7. Ensure no agent or background job still uses the tree.
8. Run `git worktree remove` and `git worktree prune`; delete an unneeded named
   branch only after its work is integrated or deliberately discarded.
9. Nothing gets pushed unless you say so.

## Storage and settlement

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

For an anonymous worktree, a loaded background-jobs runtime is asked to stop
jobs in that tree before a workflow gate runs, and reports the stopped ids. If
termination cannot be confirmed, the failure is reported and the gate does not
run. The tree is retained regardless: quiescence protects review and manual
cleanup; it does not authorize automatic deletion. Named worktrees skip
implicit job control and keep their jobs.

At shutdown, `pi-background-jobs` calls the extension's settlement endpoint
before disposing its responder, preserving that same ordering. When the gate
runs, it still runs before settlement and lease release. Bounded shutdown
behavior is unchanged.

Monorepos: with a `cwd` inside a package, the agent works at the equivalent
subdirectory inside the copy. Configuration discovery stays anchored to the
initiating project — a named branch's own `.pi` extensions are not loaded.

## Turning isolation off

| Level | How |
|---|---|
| Per call | Omit `isolation` and `branch`, or pass `isolation: "off"` (without `branch`) |
| Per agent | `isolation: off` in frontmatter — authoritative; an explicit caller `branch` then **errors** |
| Per project | `"worktreeIsolation": false` in `subagents.json` — the parameters disappear from the schema next session, and creation is refused on every path including RPC and schedules |

Project-level off is the right call on a repository large enough that a retained
copy's setup time and disk cost are not justified.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot run with isolation: "worktree"` | Not a git repo, no commits, or `git worktree add` failed before a workspace existed | `git init` + one commit, or drop the option |
| Call fails after add, naming a retained path | Post-add verification failed | Inspect the reported path; it is retained conservatively |
| Agent reports a clean tree when reviewing "my changes" | Fresh worktree has no uncommitted caller changes | Review in the shared checkout, or commit first |
| Branch request refused as busy | Another agent holds the lease | Steer/resume that agent, or pick another branch |
| Agent edited the main checkout anyway | Absolute parent paths in the brief, or it `cd`'d out | Repository-relative paths; restrict `bash` |
| Worktree still on disk after the run | Expected retention | Review, integrate or discard, then remove and prune it |
| Completion says the retained tree changed | Agent left staged, unstaged, untracked or committed work | Inspect at the reported path; decide integration or discard |
| Acquisition fails naming `.gitignore` | Container inside the repo is not ignored | Add the rule to `.git/info/exclude` and retry |
