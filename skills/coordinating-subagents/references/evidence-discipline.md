# Evidence discipline

A subagent's final message is a claim. It describes what the agent believed it
did. Treating that as evidence is how a fleet produces confident, wrong work at
scale — and the more agents you run, the more claims you accumulate and the less
time you have to check each one.

## Contents

- [The rule](#the-rule)
- [Strength of evidence](#strength-of-evidence)
- [Verify by running](#verify-by-running)
- [Adversarial verification](#adversarial-verification)
- [Perspective diversity](#perspective-diversity)
- [Handling disagreement](#handling-disagreement)
- [Partial results](#partial-results)
- [What you may state to the user](#what-you-may-state-to-the-user)
- [Cheap habits that catch most of it](#cheap-habits-that-catch-most-of-it)

## The rule

**Trust but verify.** An agent's summary describes intent, not outcome. Before
reporting delegated work as done, look at the artifact it claims to have
produced: the diff, the file, the command output.

This is not distrust of the model. It is that an agent operating in its own
context has no way to know what it could not see — a second call site, a test it
did not run, a file that did not exist yet when it read the directory.

## Strength of evidence

From strongest to weakest:

1. **A command you ran, or a `gate:` that passed.** The test suite does not
   flatter anyone.
2. **The diff, read by you.** Cheap, and catches scope violations the agent would
   not think to mention.
3. **An artifact that exists and has the right shape.** The file is there, the
   schema validates.
4. **An independent agent that tried to refute the claim and failed.** Useful
   when the claim is not mechanically checkable.
5. **A second agent that agreed.** Weak — agreement between models correlates.
6. **The original agent's own summary.** Not evidence.
7. **The original agent re-asked whether it was right.** Worse than nothing: it
   will confirm.

Move a claim up this list before acting on it, in proportion to what acting on it
costs.

## Verify by running

If success is expressible as a command, make the command the acceptance
criterion, not a request in prose.

- In a brief: *"Done when `npm test -- session-resume` exits zero. Paste the
  output."*
- In a workflow: `agent(prompt, { gate: 'npm test' })` — the gate runs in the
  child's effective working directory after it finishes and before worktree
  settlement or lease release; a non-zero exit fails the agent and the command
  output becomes the error.
- After the fact: run it yourself. One command beats a paragraph of reasoning
  about whether the change is correct.

A gate is stronger than an instruction because it is not negotiable. An agent
told to run the tests may run them, read a failure, conclude it is unrelated, and
report success.

Gate caveats: a resumed child does not inherit its gate, so re-verification needs
a fresh gated call in the same workspace. And a gate proves the command passed —
not that the command tests the thing you cared about.

## Adversarial verification

When a claim cannot be checked by running something, give it to a fresh agent
and ask it to **refute**, not to review.

> Try to refute this finding: `src/api/admin.ts` has no auth middleware on the
> `POST /admin/users` route. Default to "refuted" if you are uncertain. Report
> verdict (refuted | holds | untestable) and the file:line evidence that decided
> it.

Why this framing:

- "Review this" invites agreement; models are agreeable.
- The default-to-refuted bias counteracts the reporter's optimism.
- An explicit `untestable` verdict gives the agent somewhere to go other than
  fabricating a conclusion.

For high-stakes claims run three refuters and take a majority. In a workflow this
is a `parallel` over the same claim with different verifier prompts, or the
`pipeline` shape where each finding verifies as soon as it is found.

The verifier must be **independent**: a fresh agent, given the claim and the
evidence, not the conversation in which the claim was produced. Resuming the
original agent to check itself is the one thing that never works.

## Perspective diversity

When something can fail in more than one way, three identical refuters is worse
than three different lenses:

| Lens | Asks |
|---|---|
| Correctness | Does it do what it claims, on the inputs it will get? |
| Security | What does this let someone do that they could not before? |
| Regression | What else used this? Who called the old shape? |
| Reproduction | Can I make the reported failure happen? |
| Cost | What does this do at scale, on the hot path? |

Redundancy catches confidence errors. Diversity catches blind spots. Use
diversity when the failure modes are genuinely different, redundancy when you are
worried about one model getting one fact wrong.

## Handling disagreement

Two agents contradicting each other is information, not noise. In order:

1. **Find the check.** Can a command settle it? Run it.
2. **Compare evidence, not conclusions.** Ask each for file:line. Usually one of
   them read a different file, or an older version.
3. **Give both claims to a third agent** with the evidence and ask which is
   supported. Do not tell it which came from which agent.
4. **If it stays unresolved, say so.** An unresolved disagreement reported
   honestly is worth more than a coin flip reported confidently.

## Partial results

A result carrying `steered`, `aborted` or `stopped` is partial by definition:

- `steered` — hit `max_turns`, got a wrap-up warning, answered with what it had.
- `aborted` — exceeded the grace period after that warning.
- `stopped` — you or the user killed it.

The extension labels these explicitly, including for nested children. Do not
promote a partial result to a finding without checking what it did not get to.
The transcript's last few turns usually show exactly where it ran out.

The same applies to `null` from a workflow `agent()` call: a terminal failure and
an inspector skip are indistinguishable. Filter, and log what you dropped.

## What you may state to the user

- Say **verified** only for things you checked, and name the check.
- Say **reported** for an agent's claim you did not verify, and say so plainly.
- Never quote a benchmark, test count, timing, or "no behavior change" you did
  not measure. This includes numbers an agent reported: if you are passing them
  on, attribute them.
- Name what was *not* covered. A fan-out that audited 18 of 20 files audited 18
  files.
- If a workflow bounded coverage (top-N, sampling, no retry), say what was
  dropped. Silent truncation reads as completeness.

## Cheap habits that catch most of it

- `git diff` / `git status` after any agent that wrote code.
- Run the project's own check command once at the end of a fan-out, not per
  agent, when the agents shared a checkout.
- Ask for file:line evidence in every brief that produces findings. A finding
  without a location is unverifiable and usually wrong.
- Ask for the negative result explicitly (`report "none"`), so silence is
  distinguishable from nothing-found.
- Prefer one verified result to three unverified ones. The fan-out is only a win
  if the results are worth something.
