#!/usr/bin/env tsx
/**
 * smart-edits-eval.ts — replay a project's real edit history through tier 0
 * (and optionally tier 1) of smart edits and report precision / recall.
 *
 *   SMART_EDITS_EVAL_PG_URL=postgres://… npx tsx scripts/smart-edits-eval.ts <projectId> [--split 0.8] [--jev 40]
 *
 * Read-only. Defaults to the local dev-stack database.
 *
 * Method: pick a time T (the --split quantile of settled human edits). The
 * memory is built ONLY from edits settled at or before T. Every target cell's
 * text as of T is then run through the suggester, and each suggestion is
 * judged against what people actually did to that cell after T:
 *   exact    — some later edit replaced that phrase with that wording
 *   location — some later edit changed that phrase, to something else
 *   miss     — nobody touched it (a false positive the user would have seen)
 * Recall is over later pattern-sized edits whose old phrase the memory had
 * seen (the only ones tier 0 could ever find), and over all later edits.
 *
 * With --jev N, up to N "verify"-tier suggestions also go through the real Jev
 * call (OPENROUTER_API_KEY required) and are judged the same way.
 */

import dns from "node:dns"
import net from "node:net"
import { Client } from "pg"
import { bulkKeyOf, commitOrigin, settledPairs, type ChainEvent } from "../src/lib/smart-edits/chains"
import { extractEdits } from "../src/lib/smart-edits/extract"
import { observationsFromPair } from "../src/lib/smart-edits/observe"
import {
  DEFAULT_THRESHOLDS,
  findCandidates,
  keepKey,
  scoreCandidates,
  selectForDisplay,
  type Observation,
  type ScoredSuggestion,
  type Thresholds,
} from "../src/lib/smart-edits/suggest"
import { tokenize } from "../src/lib/smart-edits/tokens"
import { buildVerifyRequest, KEEP, parseVerifyAnswers, VERIFY_MIN_PROBABILITY } from "../src/lib/smart-edits/jev-request"
import { JEV_DECISIONS_URL, JEV_MODEL } from "../src/lib/completion/seam-request"

dns.setDefaultResultOrder("ipv4first")
net.setDefaultAutoSelectFamily?.(false)

const args = process.argv.slice(2)
const projectId = args.find((a) => !a.startsWith("--"))
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : fallback
}
if (!projectId) {
  console.error("usage: smart-edits-eval.ts <projectId> [--split 0.8] [--jev N]")
  process.exit(1)
}
const SPLIT = flag("split", 0.8)
const JEV_SAMPLE = flag("jev", 0)
const url = process.env.SMART_EDITS_EVAL_PG_URL?.trim() || "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"

interface Row {
  id: string
  parent_id: string | null
  author: string
  server_ts: string
  file_id: string
  cell_id: string
  lane: string
  payload: Record<string, unknown>
  prov_origin: string | null
}

const key = (r: { file_id: string; cell_id: string; lane: string }) => `${r.file_id}\u0001${r.cell_id}\u0001${r.lane}`

async function main(): Promise<void> {
  const db = new Client({ connectionString: url })
  await db.connect()
  await db.query("SET default_transaction_read_only = on")
  const t0 = Date.now()
  const { rows } = await db.query<Row>(
    `SELECT id, parent_id, author, server_ts::text, file_id, cell_id,
            COALESCE(payload::jsonb ->> 'targetLang', '') AS lane,
            jsonb_build_object(
              'value', payload::jsonb -> 'value', 'ai_suggestion', payload::jsonb -> 'ai_suggestion',
              'agent_run_id', payload::jsonb -> 'agent_run_id', 'propagated_from_cell_id', payload::jsonb -> 'propagated_from_cell_id',
              'harmonize_origin', payload::jsonb -> 'harmonize_origin', 'smart_edit_id', payload::jsonb -> 'smart_edit_id',
              'search_query', payload::jsonb -> 'search_query', 'replace_string', payload::jsonb -> 'replace_string') AS payload,
            provenance ->> 'origin' AS prov_origin
       FROM events
      WHERE project_id = $1 AND kind = 'target.cell.commit' AND file_id IS NOT NULL AND cell_id IS NOT NULL`,
    [projectId],
  )
  const { rows: sources } = await db.query<{ file_id: string; cell_id: string; value: string }>(
    `SELECT file_id, cell_id, value FROM cells WHERE project_id = $1 AND side = 'source' AND target_lang = ''`,
    [projectId],
  )
  await db.end()
  const sourceOf = new Map(sources.map((s) => [`${s.file_id}\u0001${s.cell_id}`, s.value]))
  console.log(`loaded ${rows.length} commits, ${sources.length} source cells in ${Date.now() - t0}ms`)

  const chains = new Map<string, ChainEvent[]>()
  for (const r of rows) {
    const ev: ChainEvent = {
      id: r.id,
      parentId: r.parent_id,
      author: r.author,
      ts: Number(r.server_ts),
      value: typeof r.payload.value === "string" ? r.payload.value : "",
      origin: commitOrigin(r.payload, r.prov_origin),
      bulkKey: bulkKeyOf(r.payload),
    }
    const k = key(r)
    const list = chains.get(k)
    if (list) list.push(ev)
    else chains.set(k, [ev])
  }

  const now = Date.now()
  const pairsByCell = new Map<string, ReturnType<typeof settledPairs>>()
  const allTs: number[] = []
  for (const [k, events] of chains) {
    const pairs = settledPairs(events, now)
    pairsByCell.set(k, pairs)
    for (const p of pairs) allTs.push(p.ts)
  }
  if (allTs.length < 10) {
    console.log(`only ${allTs.length} settled human edits — nothing to evaluate`)
    return
  }
  allTs.sort((a, b) => a - b)
  const T = allTs[Math.floor(allTs.length * SPLIT)]
  const fromAi = [...pairsByCell.values()].flat().filter((p) => p.beforeOrigin === "ai").length
  console.log(`settled human edits: ${allTs.length} (${fromAi} on AI drafts); split at ${new Date(T).toISOString()}`)

  // Memory as of T.
  const memory: Observation[] = []
  for (const [k, pairs] of pairsByCell) {
    const source = sourceOf.get(k.split("\u0001").slice(0, 2).join("\u0001")) ?? ""
    for (const p of pairs) if (p.ts <= T) memory.push(...observationsFromPair(p, k, source))
  }

  // Each cell's text as of T (latest commit at or before T) and at the end.
  const snapshotAt = (events: ChainEvent[], ts: number) =>
    events.filter((e) => e.ts <= ts).sort((a, b) => b.ts - a.ts)[0]
  interface CellState { key: string; source: string; atT: ChainEvent | undefined; final: ChainEvent }
  const states: CellState[] = []
  for (const [k, events] of chains) {
    const final = snapshotAt(events, Infinity)!
    states.push({ key: k, source: sourceOf.get(k.split("\u0001").slice(0, 2).join("\u0001")) ?? "", atT: snapshotAt(events, T), final })
  }

  // Counter-evidence as of T: human-confirmed texts and reverted observations.
  const humanTexts = states.filter((s) => s.atT && s.atT.origin === "human")
  const phraseIndex = humanTexts.map((s) => ({
    key: s.key,
    text: ` ${tokenize(s.atT!.value).map((t) => t.norm).join(" ")} `,
    source: new Set(tokenize(s.source).map((t) => t.norm)),
  }))
  const textAtT = new Map(states.map((s) => [s.key, s.atT ? ` ${tokenize(s.atT.value).map((t) => t.norm).join(" ")} ` : ""]))
  const reverted = new Set(memory.filter((o) => o.newNorm && !(textAtT.get(o.cellKey) ?? "").includes(` ${o.newNorm} `)).map((o) => o.id))

  // Ground truth: what people changed after T.
  const truth = new Map<string, { ops: { oldNorm: string; newNorm: string }[] }>()
  let laterOps = 0
  for (const s of states) {
    if (!s.atT || s.final.ts <= T || s.final.origin !== "human") continue
    const { ops } = extractEdits(s.atT.value, s.final.value)
    if (ops.length) {
      truth.set(s.key, { ops })
      laterOps += ops.length
    }
  }
  const memoryOlds = new Set(memory.map((o) => o.oldNorm))
  const learnableOps = [...truth.values()].flatMap((t) => t.ops).filter((o) => o.oldNorm && memoryOlds.has(o.oldNorm)).length

  // Run the suggester over every cell as of T.
  const cells = states.filter((s) => s.atT && s.atT.value).map((s) => ({ id: s.key, source: s.source, target: s.atT!.value }))
  const tSuggest = Date.now()
  const candidates = findCandidates(cells, memory)
  const keeps = new Map<string, number>()
  for (const c of candidates) {
    for (const r of c.replacements) {
      const kk = keepKey(c.oldNorm, r.anchors)
      if (keeps.has(kk)) continue
      const needle = ` ${c.oldNorm} `
      keeps.set(kk, phraseIndex.filter((p) => p.key !== c.cellId && p.text.includes(needle) && r.anchors.every((a) => p.source.has(a))).length)
    }
  }
  const scored = scoreCandidates(candidates, { keeps, reverted, dismissals: new Map() })
  console.log(`suggested over ${cells.length} cells in ${Date.now() - tSuggest}ms (${memory.length} observations in memory)`)

  const judge = (s: ScoredSuggestion): "exact" | "location" | "miss" => {
    const t = truth.get(s.cellId)
    if (!t) return "miss"
    if (t.ops.some((o) => o.oldNorm === s.oldNorm && o.newNorm === s.newNorm)) return "exact"
    return t.ops.some((o) => o.oldNorm === s.oldNorm) ? "location" : "miss"
  }
  const report = (label: string, list: ScoredSuggestion[]) => {
    const j = list.map(judge)
    const exact = j.filter((x) => x === "exact").length
    const loc = j.filter((x) => x === "location").length
    const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—")
    console.log(
      `${label.padEnd(28)} shown ${String(list.length).padStart(6)}  exact ${pct(exact, list.length).padStart(6)}  +location ${pct(exact + loc, list.length).padStart(6)}  recall(learnable) ${pct(exact, learnableOps).padStart(6)}  recall(all) ${pct(exact, laterOps).padStart(6)}`,
    )
  }
  console.log(`\nlater edits after T: ${laterOps} ops in ${truth.size} cells; ${learnableOps} with an old phrase the memory had seen\n`)

  const sweep = (t: Thresholds) => selectForDisplay(scoreCandidates(candidates, { keeps, reverted, dismissals: new Map() }, t))
  const base = selectForDisplay(scored)
  report("tier 0 show (default)", base.filter((s) => s.tier === "show"))
  report("tier 0 verify band", base.filter((s) => s.tier === "verify"))
  for (const conf of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    for (const minStrong of [1, 2, 3]) {
      const t = { ...DEFAULT_THRESHOLDS, showMinConfidence: conf, showMinStrong: minStrong }
      report(`show conf≥${conf} strong≥${minStrong}`, sweep(t).filter((s) => s.tier === "show"))
    }
  }

  if (JEV_SAMPLE > 0) {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim()
    if (!apiKey) {
      console.log("\n--jev needs OPENROUTER_API_KEY; skipped")
      return
    }
    const verify = base.filter((s) => s.tier === "verify").slice(0, JEV_SAMPLE)
    const byCell = new Map<string, ScoredSuggestion[]>()
    for (const s of verify) byCell.set(s.cellId, [...(byCell.get(s.cellId) ?? []), s])
    const picked: ScoredSuggestion[] = []
    const rejected: ScoredSuggestion[] = []
    let ms = 0
    for (const [cellId, list] of byCell) {
      const cell = cells.find((c) => c.id === cellId)!
      const req = buildVerifyRequest(JEV_MODEL, [cell], list)
      const started = Date.now()
      const res = await fetch(process.env.JEV_URL ?? JEV_DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(req),
      })
      ms += Date.now() - started
      if (!res.ok) {
        console.log(`jev ${res.status}`)
        continue
      }
      parseVerifyAnswers(await res.json(), list.length).forEach((a, i) => {
        const s = list[i]
        if (!a || a.choice === KEEP || a.probability < VERIFY_MIN_PROBABILITY) rejected.push(s)
        else picked.push(a.choice === 0 ? s : { ...s, ...s.alternatives[a.choice - 1] })
      })
    }
    console.log(`\njev: ${byCell.size} calls, mean ${(ms / Math.max(1, byCell.size)).toFixed(0)}ms`)
    report("tier 1 jev picked", picked)
    report("tier 1 jev rejected", rejected)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
