# Choosing a model for a subagent

Data retrieved **2026-09-19** from [models.dev](https://models.dev/api.json) plus
vendor documentation, and cross-checked against `pi --list-models` on this
machine. **Model IDs, prices and limits change weekly — re-verify before quoting
one.** Use the `models-dev` skill for live data and `pi --list-models <pattern>`
for what is actually reachable here.

## Contents

- [How to pick](#how-to-pick)
- [Job to model](#job-to-model)
- [What the tiers mean](#what-the-tiers-mean)
- [Vendor snapshot](#vendor-snapshot)
- [Provider routes and exact IDs](#provider-routes-and-exact-ids)
- [Thinking levels](#thinking-levels)
- [Designing a fallback list](#designing-a-fallback-list)
- [Cost control](#cost-control)
- [Verifying before you quote](#verifying-before-you-quote)

## How to pick

Four questions, in order:

1. **Does the job need judgement, or execution?** Search, listing, mechanical
   edits and format transforms are execution — the cheapest capable model wins,
   and the money is better spent on more agents. Review, architecture and
   verification are judgement.
2. **How much must it hold at once?** A repo-wide sweep needs a large context
   window more than it needs reasoning. A single-file fix needs neither.
3. **What does being wrong cost?** A wrong search result is a wasted minute. A
   wrong "this is safe to merge" is a production incident. Spend on
   verification, not on the first draft.
4. **Would inheriting be fine?** If yes, pin nothing. An unpinned agent follows
   the caller's model and stays correct as the landscape changes.

Then sanity-check: the model must support tool calling (every coding subagent
needs it), and structured output if the agent will be used with a workflow
`schema`.

## Job to model

Picks that are reachable on this machine. Cheap/workhorse/frontier are relative
tiers, not quality rankings.

| Job | Cheap | Workhorse | Frontier |
|---|---|---|---|
| Search / locate (`Explore`) | `google/gemini-2.5-flash-lite`, `openai-codex/gpt-5.6-luna` | `claude/claude-haiku-4-5`, `google/gemini-3.8-flash` | rarely worth it |
| Mechanical edit / codemod | `zai/glm-5.3-flash`, `deepseek/deepseek-flash` | `claude/claude-haiku-4-5`, `openai-codex/gpt-5.4-mini` | rarely worth it |
| Implementation | `minimax/MiniMax-M2.7`, `openai-codex/gpt-5.6-luna` | `claude/claude-sonnet-5`, `openai-codex/gpt-5.4`, `zai/glm-5.3` | `claude/claude-opus-5`, `xai/grok-4.6` |
| Coding specialist (large edit sets) | — | `opencode/gpt-5.3-codex`, `opencode/kimi-k2.7-code` | `openai-codex/gpt-6-astra` |
| Code review | `claude/claude-haiku-4-5` | `claude/claude-sonnet-5`, `google/gemini-3.8-flash` | `claude/claude-opus-5` |
| Adversarial verification | `deepseek/deepseek-flash`, `zai/glm-5.3` | `openai-codex/gpt-5.4`, `deepseek/deepseek-v4-pro` | `claude/claude-fable-5-1`, `openai-codex/gpt-6-astra` |
| Deep research / long context | `google/gemini-2.5-flash-lite` (triage) | `google/gemini-3.1-pro-preview`, `kimi-coding/k3` | `claude/claude-fable-5-1`, `openai-codex/gpt-6-astra` |
| Architecture / planning | `zai/glm-5.2` | `claude/claude-sonnet-5`, `openai-codex/gpt-5.4` | `claude/claude-opus-5`, `openai-codex/gpt-6-astra` |

Two structural notes:

- **Verification deserves a different model from production.** Two runs of the
  same model correlate; a refuter on a different vendor catches what a same-model
  reviewer rubber-stamps.
- **Fan-outs are where cheap models pay.** Twenty cheap agents plus one strong
  synthesis usually beats five strong agents at the same price.

## What the tiers mean

| Tier | Roughly | Good at | Bad at |
|---|---|---|---|
| Cheap / fast | ≤ $1 in, ≤ $5 out per M | Search, listing, extraction, single-file mechanical edits, first-pass triage | Multi-file consistency, ambiguity, knowing when to stop |
| Workhorse | ~$1-3 in, ~$4-15 out | Implementation, review, most delegated coding | Novel architecture, adversarial reasoning |
| Frontier | ≥ $5 in, ≥ $25 out | Architecture, verification, long-horizon research, anything where being wrong is expensive | Being run twenty times in parallel |

## Vendor snapshot

Prices are USD per million tokens, input/output, as of the retrieval date.
`R` = reasoning/thinking controls, `T/S` = tool calling / structured output
(`?` = undocumented).

| Vendor | Model | Context / max out | Price | R | T/S | Use for |
|---|---|---|---|---|---|---|
| Anthropic | `claude-haiku-4-5` | 200K / 64K | $1 / $5 | budget | Y/Y | Search, review triage, cheap edits |
| | `claude-sonnet-5` | 425K–1M / 128K | $2 / $10 | low–max | Y/Y | Default workhorse |
| | `claude-opus-5` | 425K–1M / 128K | $5 / $25 | low–max | Y/Y | Verification, architecture |
| | `claude-fable-5-1` | 425K–1M / 128K | $10 / $50 | low–max | Y/Y | Long-horizon research/planning |
| OpenAI | `gpt-5.6-luna` | 372K–1.1M / 128K | $0.20 / $1.20 | none–max | Y/Y | Very cheap bulk work |
| | `gpt-5.4` | 272K / 128K | $2.50 / $15 | none–xhigh | Y/Y | Implementation, review |
| | `gpt-5.3-codex` | 400K / 128K | $1.75 / $14 | none–xhigh | Y/Y | Coding specialist |
| | `gpt-6-astra` | 425K–1.1M / 128K | $10 / $50 | low–max | Y/Y | Frontier reasoning |
| Google | `gemini-2.5-flash-lite` | 1M / 65.5K | $0.10 / $0.40 | toggle | Y/Y | Cheapest sweep/triage |
| | `gemini-3.8-flash` | 1M / 65.5K | $0.75 / $3.75 | low–high | Y/Y | Fast workhorse |
| | `gemini-3.1-pro-preview` | 1M / 65.5K | $2 / $12 | low–high | Y/Y | Long-context research |
| DeepSeek | `deepseek-flash` | 1M / 384K | ~$0.15 / $0.60 | toggle | Y/Y | Cheap reasoning, verification |
| | `deepseek-v4-pro` | 1M / 384K | disputed, see below | toggle | Y/— | Cheap frontier-value reasoning |
| Z.ai | `glm-5.3-flash` | 1M / 131K | $0.15 / $0.50 | low/high/max | Y/Y | Cheap edits and locating |
| | `glm-5.3` | 1M / 131K | $1.40 / $4.40 | low/high/max | Y/— | Workhorse implementation |
| | `glm-5.2` | 1M / 131K | $1.40 / $4.40 | high/max | Y/— | Planning on a budget |
| xAI | `grok-4.6` | 500K / 500K | $2 / $6 | low–xhigh | Y/Y | Frontier-value coding/research |
| | `grok-4.5` | 500K / 500K | — | yes | Y/Y | Previous generation |
| Moonshot | `kimi-k2.7-code` | 262K / 262K | $0.95 / $4 | yes | Y/Y | Coding specialist, large edit sets |
| | `k3` (`kimi-coding`) | 1M / 131K | $3 / $15 | toggle | Y/Y | Deep research, architecture |
| MiniMax | `MiniMax-M2.7` | 205K / 131K | $0.30 / $1.20 | yes | Y/? | Cheap implementation/refactor |
| | `MiniMax-M3` | 1M / 512K | $0.30 / $1.20 | toggle | Y/Y | Long implementation runs |

**Long-context surcharges** apply above a threshold on several models (GPT-5.4
above 272K: $5/$22.50; GPT-6 Astra: $20/$75; GPT-5.6 Luna: $0.40/$1.80; Gemini
3.1 Pro above 200K: $4/$18; Grok 4.6 above 200K: $4/$12; MiniMax M3 above 512K:
$0.60/$2.40). An agent that habitually fills a huge window can cost several times
its headline rate — which is another reason to decompose rather than to buy
context.

**Known conflict:** models.dev lists DeepSeek V4 Pro at $0.435/$0.87 while
DeepSeek's own pricing page says $0.66/$1.98 off-peak and $1.32/$3.96 peak. Use
the vendor page for budgeting.

**Unknowns:** MiniMax does not publish structured-output support; absence in
models.dev means undocumented, not unsupported. `grok-4.1-fast` pricing was not
cleanly exposed — prefer `grok-4.6` for new routing.

## Provider routes and exact IDs

Frontmatter `models:` entries are matched **exactly**, so take the pair straight
from `pi --list-models`: the provider column and the model column, joined with a
slash.

```yaml
models:
  - claude/claude-sonnet-5:high
  - openai-codex/gpt-5.4:high
  - zai/glm-5.3
```

Things that bite:

- **Provider prefixes here are not vendor names.** Anthropic models are under
  `claude/`, OpenAI's under `openai-codex/`, Moonshot's under `kimi-coding/`,
  Z.ai's under `zai/`. There are also aggregator routes (`opencode/`,
  `openrouter/`, `synthetic/`, `huggingface/`) carrying many vendors' models.
- **The same model differs by route.** `claude/claude-sonnet-5` advertises 425K
  context here while `opencode/claude-sonnet-5` advertises 1M. Check the row you
  are actually going to use.
- **Dated and undated IDs both exist** (`claude-haiku-4-5` and
  `claude-haiku-4-5-20251001`). Undated is usually what you want in an agent file.
- Fuzzy names (`"haiku"`, `"sonnet"`) work only for explicit `Agent({ model })`,
  RPC and workflow `model:` overrides — **never** for frontmatter.
- `/agents → Agent types` flags a model it cannot resolve
  (`(unavailable, fallback: inherit)`) or that resolved elsewhere
  (`(→ provider/id)`). Check there after editing.

## Thinking levels

`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. pi clamps a level the
model does not support rather than failing, and `showModel` reports the effective
level beside the requested one (`thinking: low (asked max)`).

| Job | Level | Why |
|---|---|---|
| Search, listing, extraction | `off`–`low` | Reasoning tokens on a grep are pure cost |
| Mechanical edits | `low` | The decision was already made |
| Implementation | `medium` | Enough to sequence a change, not to philosophize |
| Review, planning | `high` | It has to hold several possibilities at once |
| Adversarial verification, architecture | `xhigh`–`max` | Where being wrong is expensive |

Thinking level is often a better lever than model tier: a workhorse at `high`
frequently beats a frontier model at `low`, for a fraction of the price.

## Designing a fallback list

```yaml
models:
  - claude/claude-sonnet-5:high     # preferred
  - openai-codex/gpt-5.4:high       # different vendor, comparable tier
  - google/gemini-3.8-flash:high    # cheap survivor
```

- Order by preference. Unavailable candidates are skipped at spawn.
- pi exhausts its own retries (`maxRetries`, default 3) on the active candidate
  before advancing, and advances **within the same session** without replaying
  the prompt or completed tool calls.
- Cross-vendor is the point: a list of three Anthropic models does not survive an
  Anthropic outage.
- Keep the tier roughly constant. A fallback three tiers down silently changes
  what the agent is capable of, and you will read the output as if nothing
  happened.
- `maxModelWraparounds` (default 0) allows extra full passes over the list.
- Only tool/schema/worktree failures, cancellation and non-retryable provider
  errors *stop* the walk; they do not advance it.

## Cost control

- Turn on `showCost` while tuning, and `reportUsage` if you want subagent spend
  in this session's `/cost`. A model pi has no pricing data for prints nothing
  rather than `$0.00`.
- The cheapest saving is decomposition: context is billed on every turn, so an
  agent that reads twenty files pays for them repeatedly.
- Cache-read tokens are re-billed each call. `usage` (billing view) includes
  them; the displayed `tokens` total does not.
- Before upgrading an agent's model, check whether it is failing for reasoning or
  for context. Compaction (`⇊N`) and high context percentage mean the task is too
  big, and a stronger model will fail the same way, slower and dearer.

## Verifying before you quote

1. Read `/home/furbyhaxx/.pi/profiles/quick/skills/models-dev/SKILL.md` and query
   models.dev for live IDs, prices and limits.
2. `pi --list-models <pattern>` for what is reachable and under which provider.
3. Vendor pricing pages when money matters — models.dev occasionally lags.
4. Never state a model ID, price or context window from memory. A hallucinated
   model ID in an agent file silently falls back to inheriting the parent model,
   which is the failure that is hardest to notice.
