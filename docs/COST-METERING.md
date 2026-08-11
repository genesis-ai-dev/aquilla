# Cost metering — measuring agent throughput and token cost

How to measure what a translation run actually costs, on either agent surface,
and turn that into a per-word figure you can price against any vendor's rate
card.

**Everything here is off by default.** The meter writes nothing and creates no
table unless `COST_METER=1` is set, so a deployed environment is untouched.

---

## Why this exists

You cannot price a translation product from a vendor's per-token rate alone,
because the pipeline does not send the text once. Each passage passes through
construe → summarize → draft → a three-verifier panel, and every one of those
calls re-carries the scene brief, rules, and register block. The measured
amplification on a 1,078-verse Greek corpus was **~35 input tokens and ~15
output tokens per source word** — roughly 50× the raw text.

That multiplier, not the rate card, is what determines margin. It has to be
measured, and it differs per surface (see *Two surfaces* below).

---

## What gets recorded

One row per model call and per tool call, in `agent_cost_meter`:

| Column | Meaning |
|---|---|
| `surface` | `autopilot` (the contextual graph) or `agent` (the tool-calling loop) |
| `kind` | `llm` or `tool` |
| `label` | Pipeline node (`construe`, `summarize`, `draft`, `verify:*`) or tool name |
| `span_id` | Autopilot only — `<fileId>#<startCell>..<endCell>`; the unit costs are distributed over |
| `tier` / `model` | Which tier was requested, and the model it resolved to |
| `prompt_tokens` / `completion_tokens` | From the upstream's `usage` block |
| `cost_cents` | Provider-reported cost. **0 on any non-OpenRouter upstream** — price offline instead |
| `latency_ms` | Per attempt. For `kind='tool'` this is the infra half of the cost — `run_code` is container time, `sql`/`search` are DB time, none of which appears as tokens |
| `ok` | False when the call threw or returned no usage block |

Two deliberate choices:

- **Failed calls are recorded.** A model that fails a parse and forces a retry
  costs twice; a ledger of successes only would hide that. Capacity rejections
  show up unmistakably as zero-token rows with ~50ms latency.
- **Raw tokens, not dollars.** `usage.cost` is an OpenRouter extension and is
  absent from every self-hosted upstream. Recording tokens means one measured
  run can be re-priced against a new rate card without re-running it.

---

## Running a measurement

### 1. Enable the meter

In `auth-worker/.dev.vars`:

```
COST_METER=1
```

Restart the stack. **`.dev.vars` changes do not reach a running worker** — a
hot reload is not enough, you need `pnpm dev` again. (Wrangler prints its
binding list only on cold start, so the absence of a var from the log does not
prove it is unset.)

### 2. Point at whichever model you want to price

Also in `.dev.vars`:

```
OPENROUTER_BASE_URL=https://your-host/v1
OPENROUTER_API_KEY=<any non-empty, non-"mock" value>
CONTEXTUAL_FAST_MODEL=<model-id>
CONTEXTUAL_DEEP_MODEL=<model-id>
AGENT_DRAFT_MODEL_DEFAULT=<model-id>
AGENT_MODEL_DEFAULT=<model-id>
AI_ALLOWED_MODELS=<model-id>
```

Three traps, all of which produce silent wrong answers rather than errors:

- **`AI_ALLOWED_MODELS` is required for a non-Anthropic model.** `lib/ai-budget.ts`
  rejects anything outside its allowlist, and the autopilot start route 4xxs.
- **An empty or `"mock"` API key makes `scripts/dev-stack.ts` start its scripted
  mock and override `OPENROUTER_BASE_URL`** — you would measure the mock. Any
  other non-empty value suppresses it.
- **Pin every tier to one model id if the host swaps models on demand**
  (llama-swap does). A stray request for a second model evicts the first and
  stalls the run.

### 3. Size concurrency to the upstream

Span concurrency is **not** request concurrency: a high-risk span fans its
verifier panel out three-wide, so N spans burst to roughly 3N requests. Against
a host with a fixed slot count the surplus is rejected, and a rejected
`ambiguity` verifier fails its **entire span** — contention destroys work
rather than merely slowing it.

```
CONTEXTUAL_MAX_CONCURRENCY=6    # spans per wave
CONTEXTUAL_MAX_INFLIGHT=8       # hard ceiling on concurrent requests
```

`CONTEXTUAL_MAX_INFLIGHT` is a client-side gate in `makeLlmCall`. Leave it
**unset for OpenRouter** (uncapped, unchanged behaviour); set it to the host's
slot count for anything self-hosted. To find that number, fire N concurrent
trivial requests and see where they start being rejected.

### 4. Drive the autopilot

```bash
npx tsx scripts/cost-run.ts <projectId>
```

Starts a project-wide run and re-kicks it whenever it parks. The re-kick exists
because `selfTickLoop` stops after `MAX_WAVES_PER_LOOP` and parks; in production
a 5-minute cron sweep adopts parked runs, but **Miniflare never fires scheduled
Workers**, so on the dev stack nothing rescues it.

> Do not edit worker source while a run is in flight. Every edit hot-reloads
> wrangler, which kills the in-flight loop and strands the run at `running` with
> no driver — the exact state the cron sweeper exists to fix.

### 5. Drive the agent

```bash
npx tsx scripts/cost-agent.ts <projectId>          # all tasks
npx tsx scripts/cost-agent.ts <projectId> --list   # show them
npx tsx scripts/cost-agent.ts <projectId> --only 3 # just one
```

Each task is a separate agent run exercising different tools and different
amounts of exploration. Edit the `TASKS` array to match the workload you
actually want to price — the spread between a cheap lookup and an open-ended
analysis *is* the number you are looking for.

### 6. Report

```bash
npx tsx scripts/cost-report.ts --project <projectId>                  # autopilot (default)
npx tsx scripts/cost-report.ts --project <projectId> --surface agent
npx tsx scripts/cost-report.ts --project <projectId> --surface all
```

The two surfaces have different cost shapes and are **not** aggregated by
default — see below. Other flags: `--run <runId>`, `--json`.

The price table is a constant at the top of `scripts/cost-report.ts`. Rows
marked `verified: false` print an `UNVERIFIED` warning; set them from the
vendor's pricing page before quoting anything externally.

---

## Two surfaces, two cost shapes

Measured on the same project, the difference is structural, not incidental:

| | Autopilot (graph) | Agent (tool loop) |
|---|---|---|
| Input : output | ~2.4 : 1 | **~41 : 1** |
| Floor per unit of work | ~1,100 input tokens per call | **~10,500 input tokens per turn** |
| Variance | Fixed graph — low | **~4.5×**, driven by how much the model explores |

The autopilot is **output-heavy**: it is generating translation. The agent is
**input-heavy**: it re-sends the system prompt, all ~15 tool schemas, and every
accumulated tool result on each turn just to decide what to do next.

Two consequences for any pricing model built on this:

- **Price agent turns on input tokens.** Prompt caching is therefore the
  dominant cost lever there (~90% off cached input), and tool-schema weight is
  fixed overhead paid on every single turn.
- **Batch size is the agent's biggest knob.** Its overhead is per-turn, so
  drafting 40 cells per turn rather than 10 amortises it roughly 4×.

---

## Reading the report

- **`cost per 10,000 processed words`** normalises by the words the run
  *actually* processed, not the whole corpus. A span that failed produced no
  translation but still spent its tokens, so charging its words against the run
  would understate cost.
- **`per-span cost distribution`** gives median / p75 / p90. Percentiles need
  many samples: two documents give two data points, but the ~100+ spans inside
  them give a usable distribution. The span is the unit of work.
- **`spans … produced nothing`** is the waste line. High values usually mean the
  model is emitting malformed structured output, not that the pipeline is slow.
- **`TIER_WEIGHTS calibration`** compares measured tokens per tier against the
  `fast:1 mid:5 deep:25` weights assumed in `lib/contextual/types.ts`, which cap
  every span's budget. **It self-suppresses when all tiers resolve to one model**
  — it can only calibrate relative *price*, and one model has none.

---

## Known limits

- **Token counts belong to whichever model produced them.** Re-pricing across
  vendors is approximate: tokenizers differ, badly so for non-Latin scripts.
  Call counts, phase mix, and retry rates transfer cleanly; absolute token
  totals drift. Use `count_tokens` against the target model to close this.
- **`cost_cents` is 0 off OpenRouter.** By design — price from tokens.
- **A project with no terminology and no validated examples measures low.** Both
  inject text into every draft prompt, so a mature project's prompts are
  materially larger. Seed them before treating a figure as representative.
- **Container time is only partly captured.** `run_code` latency is recorded,
  but only if a task actually invokes it — the model will often prefer `sql`.

---

## Related

- `auth-worker/src/lib/cost-meter.ts` — the ledger and its `COST_METER` gate
- `auth-worker/src/lib/contextual/tick.ts` — `makeLlmCall`, the concurrency gate, capacity retry
- `auth-worker/src/lib/llm-vendor.ts` — which usage fields each upstream needs
- `docs/AGENT-API.md`, `docs/AGENT-SANDBOX.md` — the surfaces being measured
