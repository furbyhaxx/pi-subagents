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
- [Reviewing, merging and cleaning up](#reviewing-merging-and-cleaning-up)
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

## Reviewing, merging and cleaning up

The extension gets the work *into* a workspace and leaves it there. Nothing
merges, pushes or deletes on your behalf, so a run is finished only when it has
been reviewed, integrated and removed from disk. Skipping the last step is how a
machine ends up with fifteen stale copies of the repository, one of which someone
eventually reviews by mistake.

### Find what you have

```bash
git worktree list                       # every linked worktree and its branch
git branch --list 'pi-agent-*'          # disposable runs that preserved changes
```

A disposable run reports its `pi-agent-<id>` branch in the completion message and
its directory is already gone. A named `branch` run reports the retained path,
and its files may still be uncommitted.

### Review before you merge

```bash
git log --oneline main..pi-agent-abc123          # what it did
git diff main...pi-agent-abc123                  # the change as a whole
git diff --stat main...pi-agent-abc123           # scope check: did it stay in bounds?
```

For a retained workspace, review it in place — it is a working tree:

```bash
git -C /path/to/worktree status
git -C /path/to/worktree diff
```

Two things to know before you trust what you see:

- **The automatic preservation commit uses `--no-verify`.** Your pre-commit hooks
  did not run on it. Whatever they would have caught is still in there.
- **An agent's gate proves only what the gate ran.** Re-run the project's own
  check suite after merging, in the main checkout, where the full toolchain and
  hooks apply.

Delegating the review is fine — a read-only reviewer agent pointed at
`git diff main...pi-agent-abc123`, or a fresh agent on the same `branch` with
"do not edit". Do not use a *new* worktree to review someone's uncommitted work:
a fresh copy contains committed files only.

### Merge it back

Git refuses to check out a branch that a linked worktree already holds, so merge
**from the main checkout** rather than trying to switch to it:

```bash
cd /path/to/main/checkout
git merge --no-ff pi-agent-abc123       # or feat/x
npm run check                            # validate in the real tree, with hooks
```

Other shapes, depending on what you want in history:

```bash
git cherry-pick <sha>                    # take one commit out of an agent branch
git rebase --onto main <base> feat/x     # linearize before merging
git merge --squash feat/x                # one commit, agent's history dropped
```

If the work is still uncommitted in a retained workspace, commit it there first —
the workspace is a normal checkout, so `git -C <path> add -p` and
`git -C <path> commit` work — or steer the owning agent to commit under your
commit policy. Integrate one branch at a time and re-run the check after each;
two agent branches that merge cleanly can still be semantically incompatible.

### Then clean up

Once the branch is merged into your local main, remove the copy and the branch:

```bash
git worktree remove /path/to/worktree    # refuses if the tree is dirty
git worktree prune                       # drop stale administrative records
git branch -d feat/x                     # -d refuses if it is not merged
git branch -d pi-agent-abc123            # same for a preservation branch
```

`git branch -d` failing is a feature: it means what you are about to delete is
not in your main line. Find out why before reaching for `-D`.

Four things that make removal fail or unsafe, and what they mean:

| Situation | What it means | Do |
|---|---|---|
| `remove` refuses: tree is dirty | Uncommitted or untracked files remain — possibly work you have not read | Review them; commit or discard deliberately. `--force` only after you have looked |
| An agent still owns the branch lease | A run is live in that workspace | Let it finish, or stop it; then remove |
| Background jobs are running in the tree | Something is still writing there | Stop them (`job_list`, `job_stop`) before removing |
| The directory is gone but `worktree list` still shows it | Stale administrative record | `git worktree prune` |

A disposable run needs no `worktree remove` — the copy was deleted when it
finished, unless jobs could not be confirmed stopped, in which case it was
retained on purpose and the result said so. Only the `pi-agent-*` branch is left
to delete.

### Checklist

1. `git worktree list` and `git branch --list 'pi-agent-*'` — know what exists.
2. Read the diff against the base, and check the scope it actually touched.
3. Merge from the main checkout, one branch at a time.
4. Run the project's check suite in the main checkout — hooks were bypassed.
5. `git worktree remove` + `git worktree prune`.
6. `git branch -d` for the merged branch, and let the refusal stop you if it is
   not merged.
7. Nothing gets pushed as part of this unless you say so.

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
