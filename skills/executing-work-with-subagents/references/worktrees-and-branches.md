# Worktrees and branches

Delegated work can use the shared checkout or a retained worktree on an
explicit caller-selected branch. Picking wrong costs either safety or time.

## Contents

- [Choosing](#choosing)
- [Legacy automatic branches](#legacy-automatic-branches)
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
| Caller-selected branch | `branch: "feat/x"` or `isolation: "worktree", branch: "feat/x"` | Speculative writes, risky refactors, parallel writers you may discard | Retained on the exact branch; agent commits logical changes unless told not to |

Isolation is not free: a copy costs setup time and disk per agent. Reach for it
when parallel edits would actually collide, when you might want to throw the work
away, or when the main checkout must stay usable while an agent works.

## Legacy automatic branches

Earlier releases created a `pi/<agentId>` branch when worktree isolation was
requested without `branch`. New requests never create these automatically;
`isolation: "worktree"` now requires a caller-selected branch. Existing retained
`pi/*` worktrees are not migrated or removed and remain available through
listing, resume/restore and `git worktree prune`.

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

Caller-selected worktrees follow the same retention rule: every settlement
outcome leaves the workspace in place. The agent is instructed to commit logical
conventional commits unless its task says not to; `worktreeAutoCommit` can also
stage and commit dirty trees at settlement. The extension never pushes, merges
or removes worktrees. A completion reports the retained path and change state.
Integration and cleanup belong to the orchestrating agent.

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
through execution, workflow gates and background-job quiescence for legacy
non-named worktrees. Contention **fails fast** rather than queueing: steer or resume the
owning agent, or use another branch. For legacy non-named worktrees, background
jobs are quiesced before a workflow gate runs, and the gate runs before
settlement and lease release; if quiescence cannot be confirmed, the gate does
not run. New caller-selected worktrees skip implicit job control. Retention does
not shorten this ordering.

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
root, working directory, branch, base ref, whether the branch was caller-selected,
whether it was created or reused, whether it started dirty, and that it is
retained. It also tells the agent to work in the copy, map paths into it, preserve
pre-existing changes, commit logical conventional commits unless the task says
not to, optionally rebase onto `baseRef`, avoid pushing/merging/switching to other
branches or managing worktrees, and report branch, HEAD SHA, commits and dirty
state.

So your brief should add only what is task-specific:

- **Use repository-relative paths.** Absolute paths from the parent checkout are
  the main reason agents wander out of the copy.
- **Pass `branch` as an argument.** Never ask the agent to create a worktree,
  switch branches or set up git — it will improvise.
- **Override the default only when needed.** The scope asks the agent to commit
  logical changes in conventional commits; say "Do not commit" when the task
  requires uncommitted changes. `worktreeAutoCommit` is a separate opt-in that
  stages and commits dirty worktrees at settlement.
- **State the validation**: the command that must pass, run inside the workspace.
- **Say what to preserve** when reusing a workspace that may already be dirty.

## Reviewing, integrating and cleaning up

The extension gets the work *into* a workspace and leaves it there. The agent
commits its work by default; `worktreeAutoCommit` can additionally stage and
commit a dirty tree. The extension never pushes, merges or removes worktrees. A
run is finished only when the orchestrating agent has reviewed the retained
tree, deliberately integrated or discarded it, and removed it from disk.

### Find what you have

The completion report is authoritative for the retained path and change state.
Confirm it against Git:

```bash
git worktree list
git -C /path/to/worktree status --short
git -C /path/to/worktree diff --stat
```

Every extension-created worktree is on a branch. New acquisitions use the
caller's explicit branch; existing automatic `pi/*` worktrees remain listed and
resumable. `/agents → Worktrees` shows retained paths, dirty state, ahead/behind
relative to `baseRef`, and upstream state, plus unchecked-out legacy
`pi-agent-*` branches.

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

The branch already exists in either worktree mode. If the base moved, rebase
inside the retained worktree:

```bash
git -C /path/to/worktree rebase <baseRef>
```

Then integrate from the main checkout rather than trying to check out a branch
already held by a linked worktree:

```bash
cd /path/to/main/checkout
git merge --no-ff feat/x
npm run check
```

Cherry-pick, rebase or squash are valid deliberate alternatives. Integrate one
workspace at a time and re-run checks after each; textually clean merges can
still be semantically incompatible.

If the work is unwanted, inspect it first, then discard it deliberately. Before
removal, run `git -C <worktree> status --short`, compare its HEAD against local
and remote-tracking branches, and inspect `git -C <worktree> status -sb` / branch
upstream state. A missing upstream means there is no tracking branch configured;
it does not prove that no remote copy exists. Do not mistake a clean completion
summary for permission to delete a dirty tree.

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

1. Read the completion's branch, HEAD SHA, commit list, dirty state, path and change state.
2. Confirm with `git worktree list` and `git -C <path> status --short`.
3. Compare the worktree HEAD against branches and inspect upstream/push state.
4. Read staged, unstaged, untracked and committed changes.
5. Choose integration or discard explicitly; rebase with `git rebase <baseRef>` if needed.
6. Integrate from the main checkout and run the project's checks.
7. Ensure no agent or background job still uses the tree.
8. Run `git worktree remove` and `git worktree prune`; delete an unneeded branch only after its work is integrated or deliberately discarded.
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

For a legacy non-named worktree, a loaded background-jobs runtime is asked to
stop jobs in that tree before a workflow gate runs, and reports the stopped ids.
If termination cannot be confirmed, the failure is reported and the gate does
not run. The tree is retained regardless: quiescence protects review and manual
cleanup; it does not authorize automatic deletion. New caller-selected
worktrees skip implicit job control and keep their jobs.

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
| Per agent | `isolation: off` in frontmatter — authoritative; an explicit caller `branch` then **errors**. `isolation: worktree` requires the caller to supply a branch |
| Per project | `"worktreeIsolation": false` in `subagents.json` — the parameters disappear from the schema next session, and creation is refused on every path including RPC and schedules |

Project-level off is the right call on a repository large enough that a retained
copy's setup time and disk cost are not justified.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Worktree isolation requires an explicit branch | `isolation: "worktree"` had no `branch` | Pass a branch such as `feat/<slug>` |
| `Cannot run with isolation: "worktree"` | Not a git repo, no commits, or `git worktree add` failed before a workspace existed | `git init` + one commit, or drop the option |
| Call fails after add, naming a retained path | Post-add verification failed | Inspect the reported path; it is retained conservatively |
| Agent reports a clean tree when reviewing "my changes" | Fresh worktree has no uncommitted caller changes | Review in the shared checkout, or commit first |
| Branch request refused as busy | Another agent holds the lease | Steer/resume that agent, or pick another branch |
| Agent edited the main checkout anyway | Absolute parent paths in the brief, or it `cd`'d out | Repository-relative paths; restrict `bash` |
| Worktree still on disk after the run | Expected retention | Review, integrate or discard, then remove and prune it |
| Completion says the retained tree changed | Agent left staged, unstaged, untracked or committed work | Inspect at the reported path; decide integration or discard |
| Acquisition fails naming `.gitignore` | Container inside the repo is not ignored | Add the rule to `.git/info/exclude` and retry |
