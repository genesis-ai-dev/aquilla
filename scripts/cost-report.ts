// cost-report — turn the agent_cost_meter ledger into an ACU / price-per-words
// report.  DEV TOOLING for the pricing exercise; not part of the product.
//
//   npx tsx scripts/cost-report.ts [--project <id>] [--run <id>] [--json]
//
// The worker records RAW TOKENS (see auth-worker/src/lib/cost-meter.ts): the
// local llama-swap upstream reports no `usage.cost`, and pricing belongs here
// anyway so one measured run can be re-priced against any vendor without
// re-running it.  Everything below the ledger read is arithmetic.

import { Client } from "pg"

// ── Price table ─────────────────────────────────────────────────────────────
// USD per 1M tokens.  Anthropic rates below are current published list prices;
// any row with `verified: false` is a placeholder you must set from the
// vendor's pricing page before quoting it externally.  The measurement is the
// tokens — this table is only the story you tell about them, so re-pricing a
// past run against a new rate card needs no re-run.
const PRICES: Record<string, { in: number; out: number; verified: boolean }> = {
  // Self-hosted: no marginal token cost. Electricity and the GPU's amortised
  // capital cost are real but are not per-token, so they belong in the ACU's
  // infra component rather than here.
  "gemma-local":       { in: 0,    out: 0,     verified: true },
  "claude-haiku-4-5":  { in: 1.00, out: 5.00,  verified: true },
  // Sonnet 5 list price; introductory $2/$10 runs through 2026-08-31, so a
  // quote dated before then should use the intro row instead.
  "claude-sonnet-5":   { in: 3.00, out: 15.00, verified: true },
  "claude-opus-5":     { in: 5.00, out: 25.00, verified: true },
  // Not an Anthropic model — confirm against DeepSeek's current pricing.
  "deepseek-chat":     { in: 0.28, out: 0.42,  verified: false },
}

const PG_URL =
  process.env.LOCAL_PG_URL ||
  process.env.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ||
  "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"

const argv = process.argv.slice(2)
const arg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}
const AS_JSON = argv.includes("--json")

interface MeterRow {
  surface: string
  run_id: string
  project_id: string
  kind: string
  label: string
  span_id: string
  tier: string | null
  model: string | null
  prompt_tokens: number
  completion_tokens: number
  latency_ms: number
  ok: boolean
}

interface SpanSeed {
  id: string
  startCellId: string
  endCellId: string
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`)

/** Nearest-rank percentile over a sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]
}

function priceOf(promptTokens: number, completionTokens: number, key: string): number {
  const p = PRICES[key]
  if (!p) return 0
  return (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: PG_URL })
  await client.connect()
  try {
    const where: string[] = []
    const binds: string[] = []
    const projectId = arg("--project")
    const runId = arg("--run")
    if (projectId) { binds.push(projectId); where.push(`project_id = $${binds.length}`) }
    if (runId) { binds.push(runId); where.push(`run_id = $${binds.length}`) }
    // Autopilot and agent are different cost shapes — a fixed graph vs a
    // model-driven loop. Aggregating them into one token total is meaningless,
    // so default to autopilot and make mixing an explicit choice.
    const surface = arg("--surface") ?? "autopilot"
    if (surface !== "all") { binds.push(surface); where.push(`surface = $${binds.length}`) }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""

    const exists = await client.query(
      `SELECT to_regclass('public.agent_cost_meter') IS NOT NULL AS present`,
    )
    if (!exists.rows[0]?.present) {
      console.error("agent_cost_meter does not exist yet — run the agent or autopilot once first.")
      process.exit(1)
    }

    const { rows } = await client.query<MeterRow>(
      `SELECT surface, run_id, project_id, kind, label, span_id, tier, model,
              prompt_tokens, completion_tokens, latency_ms, ok
         FROM agent_cost_meter ${clause}
        ORDER BY id`,
      binds,
    )
    if (rows.length === 0) {
      console.error("no ledger rows matched.")
      process.exit(1)
    }

    // ── Source words: the denominator for "cost per 10k words" ──────────────
    // Source side only. The target side is what the run PRODUCES, and it does
    // not exist yet for an untranslated project, so it cannot be the unit of
    // work priced here.
    const projects = [...new Set(rows.map((r) => r.project_id))]
    const wordsRes = await client.query<{ words: string; cells: string }>(
      `SELECT COALESCE(SUM(word_count), 0) AS words, COUNT(*) AS cells
         FROM cells WHERE side = 'source' AND project_id = ANY($1)`,
      [projects],
    )
    const sourceWords = Number(wordsRes.rows[0]?.words ?? 0)
    const sourceCells = Number(wordsRes.rows[0]?.cells ?? 0)

    // DELIVERED words — the only honest denominator. A span's tokens are spent
    // whether or not it produces a draft, so crediting a failed span's words
    // halves the apparent cost of a run that wasted half its compute. Measured
    // from the drafts that actually landed, not from the spans that were tried.
    const deliveredRes = await client.query<{ cells: string; words: string }>(
      `SELECT COUNT(*) AS cells, COALESCE(SUM(s.word_count), 0) AS words
         FROM (SELECT DISTINCT cell_id, project_id FROM contextual_drafts
                WHERE project_id = ANY($1) AND status IN ('proposed','applied')) d
         JOIN cells s ON s.project_id = d.project_id
                     AND s.cell_id = d.cell_id AND s.side = 'source'`,
      [projects],
    )
    const deliveredWords = Number(deliveredRes.rows[0]?.words ?? 0)
    const deliveredCells = Number(deliveredRes.rows[0]?.cells ?? 0)

    // ── Totals ─────────────────────────────────────────────────────────────
    const llm = rows.filter((r) => r.kind === "llm")
    const tools = rows.filter((r) => r.kind === "tool")
    const promptTokens = llm.reduce((a, r) => a + r.prompt_tokens, 0)
    const completionTokens = llm.reduce((a, r) => a + r.completion_tokens, 0)
    const failed = rows.filter((r) => !r.ok)
    const wallMs = rows.reduce((a, r) => a + r.latency_ms, 0)

    const priceKeys = Object.keys(PRICES)
    const out: string[] = []
    const p = (s = "") => out.push(s)

    // Span outcomes: a span that failed produced NO translation, but its tokens
    // were still spent. Reporting cost without this makes a run that wasted half
    // its compute look as efficient as one that wasted none.
    const runIdsAll = [...new Set(rows.map((r) => r.run_id))]
    const outcome = await client.query<{ done: number; failed: number; total: number }>(
      `SELECT COALESCE(SUM(done_spans),0)::int AS done,
              COALESCE(SUM(failed_spans),0)::int AS failed,
              COALESCE(SUM(total_spans),0)::int AS total
         FROM contextual_runs WHERE id = ANY($1)`,
      [runIdsAll],
    )
    const spansDone = outcome.rows[0]?.done ?? 0
    const spansFailed = outcome.rows[0]?.failed ?? 0
    const spansTotal = outcome.rows[0]?.total ?? 0

    p(`surface          ${surface}`)
    p(`ledger rows      ${rows.length}  (${llm.length} model calls, ${tools.length} tool calls)`)
    p(`runs             ${runIdsAll.length}`)
    if (spansTotal > 0) {
      p(`spans            ${spansDone} succeeded, ${spansFailed} failed, of ${spansTotal} seeded` +
        `  (${pct(spansFailed, spansDone + spansFailed)} of attempted spans produced nothing)`)
    }
    p(`source corpus    ${sourceWords.toLocaleString()} words in ${sourceCells.toLocaleString()} cells`)
    p(`delivered        ${deliveredWords.toLocaleString()} words in ${deliveredCells.toLocaleString()} cells` +
      `  (${pct(deliveredWords, sourceWords)} of the corpus)`)
    p(`tokens           ${promptTokens.toLocaleString()} in / ${completionTokens.toLocaleString()} out`)
    p(`failed calls     ${failed.length}  (${pct(failed.length, rows.length)} of all calls)`)
    p(`model wall-clock ${(wallMs / 1000 / 60).toFixed(1)} min summed across calls`)
    p()

    // ── Where the compute goes ─────────────────────────────────────────────
    p(`── by node / tool ${"─".repeat(56)}`)
    p(`${"label".padEnd(24)}${"kind".padEnd(6)}${"calls".padStart(7)}${"in".padStart(11)}${"out".padStart(10)}${"fail".padStart(7)}${"avg s".padStart(8)}`)
    const byLabel = new Map<string, MeterRow[]>()
    for (const r of rows) {
      const k = `${r.label || "(unlabelled)"}|${r.kind}`
      const list = byLabel.get(k) ?? []
      list.push(r)
      byLabel.set(k, list)
    }
    const labelRows = [...byLabel.entries()]
      .map(([k, rs]) => ({
        label: k.split("|")[0],
        kind: k.split("|")[1],
        calls: rs.length,
        pin: rs.reduce((a, r) => a + r.prompt_tokens, 0),
        pout: rs.reduce((a, r) => a + r.completion_tokens, 0),
        fails: rs.filter((r) => !r.ok).length,
        avgS: rs.reduce((a, r) => a + r.latency_ms, 0) / rs.length / 1000,
      }))
      .sort((a, b) => b.pin + b.pout - (a.pin + a.pout))
    for (const l of labelRows) {
      p(
        l.label.slice(0, 23).padEnd(24) + l.kind.padEnd(6) +
        String(l.calls).padStart(7) + l.pin.toLocaleString().padStart(11) +
        l.pout.toLocaleString().padStart(10) + String(l.fails).padStart(7) +
        l.avgS.toFixed(1).padStart(8),
      )
    }
    p()

    // ── Per-span distribution (autopilot only) ─────────────────────────────
    // Percentiles need many samples. Two documents give two data points; the
    // ~200 spans inside them give a usable distribution, so the unit of work
    // here is the span, normalised to 10k words by its own source word count.
    const spanRows = llm.filter((r) => r.span_id)
    if (spanRows.length > 0) {
      // A span id is `<fileId>#<startCellId>..<endCellId>` (segment.ts). Parsing
      // it beats reading contextual_runs.span_cursor: no second query, and it
      // still resolves after the run row is gone or its cursor was consumed.
      const seeds: SpanSeed[] = [...new Set(spanRows.map((r) => r.span_id))].flatMap((id) => {
        const hash = id.indexOf("#")
        const sep = id.indexOf("..", hash + 1)
        if (hash === -1 || sep === -1) return []
        return [{
          id,
          startCellId: id.slice(hash + 1, sep),
          endCellId: id.slice(sep + 2),
        }]
      })

      // Words per span: source cells between the seed's start and end, in
      // document order (sequence_index, then canonical_ref as the tiebreak the
      // importer guarantees).
      const cellRes = await client.query<{ cell_id: string; word_count: number }>(
        `SELECT cell_id, word_count FROM cells
          WHERE side = 'source' AND project_id = ANY($1)
          ORDER BY sequence_index NULLS LAST, canonical_ref`,
        [projects],
      )
      const order = new Map(cellRes.rows.map((c, i) => [c.cell_id, i]))
      const words = cellRes.rows.map((c) => c.word_count)
      const spanWords = new Map<string, number>()
      for (const s of seeds) {
        const a = order.get(s.startCellId)
        const b = order.get(s.endCellId)
        if (a === undefined || b === undefined) continue
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        spanWords.set(s.id, words.slice(lo, hi + 1).reduce((x, y) => x + y, 0))
      }

      const bySpan = new Map<string, { pin: number; pout: number; calls: number }>()
      for (const r of spanRows) {
        const cur = bySpan.get(r.span_id) ?? { pin: 0, pout: 0, calls: 0 }
        cur.pin += r.prompt_tokens
        cur.pout += r.completion_tokens
        cur.calls++
        bySpan.set(r.span_id, cur)
      }

      p(`── per-span distribution ${"─".repeat(49)}`)
      p(`  spans measured   ${bySpan.size}${seeds.length ? ` of ${seeds.length} seeded` : ""}`)
      const callsPer = [...bySpan.values()].map((v) => v.calls).sort((a, b) => a - b)
      p(`  calls per span   median ${percentile(callsPer, 50)}  p75 ${percentile(callsPer, 75)}  p90 ${percentile(callsPer, 90)}  max ${callsPer[callsPer.length - 1]}`)

      const priced = [...bySpan.entries()]
        .map(([id, v]) => ({ id, v, w: spanWords.get(id) ?? 0 }))
        .filter((x) => x.w > 0)
      if (priced.length === 0) {
        p(`  (no span could be matched to source words — skipping per-10k percentiles)`)
      } else {
        const attemptedWords = priced.reduce((a, x) => a + x.w, 0)
        p(`  spans with words ${priced.length}`)
        p(`  words attempted  ${attemptedWords.toLocaleString()} (spans tried, delivered or not)`)
        p()

        // Two denominators, because they answer different questions and the
        // gap between them IS the waste. "Delivered" is what you actually got
        // for the tokens you actually spent — the number to quote. "Attempted"
        // is the floor the same pipeline would reach if every span succeeded.
        p(`── cost per 10,000 words ${"─".repeat(49)}`)
        p(`  ${"model".padEnd(20)}${"run total".padStart(11)}${"/10k delivered".padStart(16)}${"/10k if no waste".padStart(18)}`)
        for (const key of priceKeys) {
          const total = priceOf(promptTokens, completionTokens, key)
          const perDelivered = deliveredWords > 0 ? total * (10_000 / deliveredWords) : 0
          const perAttempted = attemptedWords > 0 ? total * (10_000 / attemptedWords) : 0
          const flag = PRICES[key].verified ? "" : "  ← UNVERIFIED"
          p(`  ${key.padEnd(20)}${usd(total).padStart(11)}${usd(perDelivered).padStart(16)}${usd(perAttempted).padStart(18)}${flag}`)
        }
        if (deliveredWords > 0 && attemptedWords > deliveredWords) {
          p(`  waste factor ${(attemptedWords / deliveredWords).toFixed(2)}x — tokens were spent on ${pct(attemptedWords - deliveredWords, attemptedWords)} more`)
          p(`  words than the run actually translated.`)
        }
        p()
        p(`── per-span cost distribution ${"─".repeat(44)}`)
        p(`  (each span normalised by its own words, whether or not it delivered)`)
        p(`  ${"model".padEnd(20)}${"median".padStart(11)}${"p75".padStart(11)}${"p90".padStart(11)}   per 10k words`)
        for (const key of priceKeys) {
          const per10k = priced
            .map((x) => priceOf(x.v.pin, x.v.pout, key) * (10_000 / x.w))
            .sort((a, b) => a - b)
          const flag = PRICES[key].verified ? "" : "  ← UNVERIFIED"
          p(
            `  ${key.padEnd(20)}${usd(percentile(per10k, 50)).padStart(11)}` +
            `${usd(percentile(per10k, 75)).padStart(11)}${usd(percentile(per10k, 90)).padStart(11)}${flag}`,
          )
        }
      }
      p()

      // ── TIER_WEIGHTS calibration ─────────────────────────────────────────
      // contextual/types.ts assumes fast:1 mid:5 deep:25 and caps spans on it.
      // Measured cost per call per tier says whether those weights are right.
      const byTier = new Map<string, { calls: number; pin: number; pout: number }>()
      for (const r of llm) {
        if (!r.tier) continue
        const cur = byTier.get(r.tier) ?? { calls: 0, pin: 0, pout: 0 }
        cur.calls++
        cur.pin += r.prompt_tokens
        cur.pout += r.completion_tokens
        byTier.set(r.tier, cur)
      }
      if (byTier.size > 0) {
        p(`── TIER_WEIGHTS calibration ${"─".repeat(46)}`)
        p(`  assumed in contextual/types.ts: fast=1 mid=5 deep=25`)
        const fast = byTier.get("fast")
        const fastAvg = fast && fast.calls > 0 ? (fast.pin + fast.pout) / fast.calls : 0
        p(`  ${"tier".padEnd(8)}${"calls".padStart(8)}${"avg tokens/call".padStart(18)}${"measured weight".padStart(18)}`)
        const tierModels = new Map<string, Set<string>>()
        for (const r of llm) {
          if (!r.tier) continue
          const s = tierModels.get(r.tier) ?? new Set<string>()
          if (r.model) s.add(r.model)
          tierModels.set(r.tier, s)
        }
        for (const [tier, v] of byTier) {
          const avg = (v.pin + v.pout) / v.calls
          const rel = fastAvg > 0 ? (avg / fastAvg).toFixed(1) : "—"
          p(`  ${tier.padEnd(8)}${String(v.calls).padStart(8)}${avg.toFixed(0).padStart(18)}${rel.padStart(18)}`)
        }
        p(`  (measured weight = avg tokens relative to the fast tier)`)
        // TIER_WEIGHTS exists to price a CHEAP model against an EXPENSIVE one.
        // If every tier resolved to the same model, this table only measures
        // prompt-size differences and says nothing about the weights.
        const distinct = new Set([...tierModels.values()].flatMap((s) => [...s]))
        if (distinct.size <= 1) {
          p(`  !! all tiers resolved to the same model (${[...distinct][0] ?? "unknown"}).`)
          p(`     These numbers reflect prompt size only — they CANNOT calibrate`)
          p(`     TIER_WEIGHTS, which encode relative model price. Re-run with`)
          p(`     distinct fast/mid/deep models to calibrate.`)
        }
        p()
      }
    }

    const unverified = priceKeys.filter((k) => !PRICES[k].verified)
    if (unverified.length > 0) {
      p(`NOTE: rates for ${unverified.join(", ")} are placeholders in this script.`)
      p(`      Set them from current vendor pricing before quoting externally.`)
      p(`NOTE: token counts come from ${[...new Set(llm.map((r) => r.model))].join(", ")}.`)
      p(`      Re-pricing across vendors is approximate — tokenizers differ, especially`)
      p(`      for Greek and Armenian. Call counts and phase mix transfer; absolute`)
      p(`      token totals drift.`)
    }

    if (AS_JSON) {
      console.log(JSON.stringify({
        rows: rows.length, llmCalls: llm.length, toolCalls: tools.length,
        promptTokens, completionTokens, sourceWords, failed: failed.length,
        byLabel: labelRows,
        perRunCost: Object.fromEntries(priceKeys.map((k) => [k, priceOf(promptTokens, completionTokens, k)])),
      }, null, 2))
    } else {
      console.log(out.join("\n"))
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
