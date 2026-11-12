// Head-to-head of the next-word / infill guessers on the TEST split, with
// paired bootstrap CIs over test verses:
//
//   BIA               — the ported Codex Editor BIA vote (+ bigram weight)
//   V6 (2024-09)      — eval-only reconstruction of Codex Editor's 2024-09
//                       TypeScript forecaster: ±1 bigrams over the corpus as
//                       one stream + similar words (scripts/lib/bia-v6.ts).
//                       Next word only.
//   chains            — per-distance chains, k = 1..3, product of experts.
//                       Next word: the last 3 words, forward. Infill: also
//                       the next 3 words, backward (bidirectional).
//   BIA + chains      — the BIA vote, weighted by the chains instead of bigram
//   source            — BIA + the project-learned source lexicon (+ bigram)
//   source + chains   — BIA + source, the MIXED score weighted by the chain product
//   previous default  — the default before the next-word retune (537d554c0)
//   default           — what the editor does now (chooseGuesser in bia-engine.ts):
//                       next word with a source = BIA vote weighted by the
//                       soft-sum chains, + 1 × source, then the bigram factor
//   BIA src+tgt corpus — plain BIA trained on the training SOURCE verses and
//                       target verses as one unaligned corpus: the spring-2024
//                       Codex Editor setup (complete_draft.txt, 2024-03-23 to
//                       2024-04-29), the only time an old forecaster saw source
//
//   pnpm bia:head-to-head [-- --pairs lowres|agnostic|all|<label substring>,...
//                             --sizes 100,250,500,1000,2000,full --positions 1500
//                             --resamples 2000 --out results.json]
//   pnpm bia:head-to-head -- --render a.json,b.json [--md docs/forecast/bia-head-to-head.md]
//
// Size N trains on the first N verse pairs of the training verses and scores
// the held-out verses of the first 2,000-verse span (the same test verses for
// every N ≤ 2000, so the sizes are comparable); "full" uses every pair.

import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { runForecastEval, splitParallel, type EvalReport } from "../src/lib/forecast/bia-eval"
import type { SuggestOptions } from "../src/lib/forecast/bia-engine"
import { AGNOSTIC_PAIRS, PARALLEL_PAIRS, type ParallelPair } from "./bia-parallel-pairs"
import { pairedBootstrap, verdict, type BootstrapResult } from "./lib/bia-bootstrap"
import { buildV6 } from "./lib/bia-v6"
import { wordKeys } from "../src/lib/forecast/forecast-tokenize"

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}

export const METHODS: Record<string, SuggestOptions> = {
  "BIA": { sourceWeight: 0, chains: false },
  "chains": { sourceWeight: 0, chains: true, chainsOnly: true },
  "BIA + chains": { sourceWeight: 0, chains: true, chainsOnly: false },
  // The source columns force the lexicon on at every size (sourceMinPairs: 0)
  // with the original mixing weight α = 2.
  "source": { chains: false, sourceWeight: 2, sourceMinPairs: 0 },
  "source + chains": { chains: true, chainsOnly: false, chainForm: "product", chainStage: "final", sourceWeight: 2, sourceMinPairs: 0 },
  // The previous default (537d554c0): bigram-weighted source mix at α = 2 for
  // next word; infill gated at SOURCE_MIN_PAIRS as now.
  "previous default": { chains: false, sourceWeight: 2 },
  // What the editor does now: chooseGuesser picks per task and project size.
  "default": {},
}
export const V6 = "V6 (2024-09)"
export const SPRING_2024 = "BIA src+tgt corpus"
const COLUMNS = ["BIA", V6, "chains", "BIA + chains", "source", "source + chains", SPRING_2024, "previous default", "default"]
/** The comparisons a default decision turns on: [task, A, B] (A − B). */
const COMPARISONS: Array<["next" | "infill", string, string]> = [
  ["next", "default", "previous default"],
  ["next", "default", "BIA"],
  ["next", "default", "chains"],
  ["next", "source + chains", "default"],
  ["next", "chains", "BIA"],
  ["next", V6, "BIA"],
  ["next", "chains", V6],
  ["next", "BIA + chains", "chains"],
  ["next", "source", "BIA"],
  ["next", "source + chains", "source"],
  ["next", SPRING_2024, "BIA"],
  ["infill", "default", "previous default"],
  ["infill", "default", "BIA"],
  ["infill", "source", "BIA"],
  ["infill", "chains", "BIA"],
  ["infill", "BIA + chains", "BIA"],
  ["infill", SPRING_2024, "BIA"],
]
const EARLY_SPAN = 2000

interface Row {
  pair: string
  size: string
  trainCells: number
  /** Cells in the spring-2024 index (target + source verses). */
  springCells: number
  testCells: number
  next: Record<string, { top1: number; top3: number; n: number; ms: number }>
  infill: Record<string, { top1: number; top3: number; n: number; ms: number }>
  ci: Array<{ task: "next" | "infill"; a: string; b: string; top1: BootstrapResult; top3: BootstrapResult }>
}

function v6Predictor(cells: string[][]): (left: string[]) => string[] {
  const v6 = buildV6(cells)
  return (left) => v6.next(left)
}

const strip = (r: EvalReport["next"]) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/^bia /, ""), { top1: v.top1, top3: v.top3, n: v.n, ms: v.ms }]))

function run(): void {
  const dir = arg("corpus-dir") ?? process.env.EBIBLE_CORPUS_DIR ?? resolve(homedir(), "Frontier/EBibleBenchmarks/corpus")
  const maxPositions = Number(arg("positions") ?? 1500)
  const resamples = Number(arg("resamples") ?? 2000)
  const sizes = (arg("sizes") ?? "100,250,500,1000,2000,full").split(",")
  const which = arg("pairs") ?? "lowres"
  const every = [...PARALLEL_PAIRS, ...AGNOSTIC_PAIRS]
  const pairs: readonly ParallelPair[] =
    which === "lowres" ? PARALLEL_PAIRS.filter((p) => p.lowResource)
      : which === "agnostic" ? AGNOSTIC_PAIRS
        : which === "all" ? every
          : every.filter((p) => which.split(",").some((s) => p.label.includes(s) || p.target.includes(s)))
  const out = arg("out") ?? "bia-head-to-head.json"
  const rows: Row[] = []
  for (const pair of pairs) {
    const src = readFileSync(resolve(dir, pair.source), "utf8").split("\n")
    const tgt = readFileSync(resolve(dir, pair.target), "utf8").split("\n")
    for (const size of sizes) {
      const limit = size === "full" ? undefined : Number(size)
      const { train, test } = splitParallel(src, tgt, 10, limit)
      const heldOut = limit === undefined ? test : test.slice(0, Math.ceil(EARLY_SPAN / 9))
      const report = runForecastEval(train, heldOut, {
        maxPositions, methods: "variants", variants: METHODS, recordHits: true,
        extraNext: { [V6]: v6Predictor(train.map((c) => wordKeys(c.text))) },
      })
      // Spring-2024: the same test positions, an index over source + target text.
      const sourceCells = train.map((c) => ({ id: `src-${c.id}`, text: c.source ?? "", validated: true, order: c.order }))
      const spring = runForecastEval([...train, ...sourceCells], heldOut, {
        maxPositions, methods: "variants", variants: { [SPRING_2024]: { sourceWeight: 0, chains: false } }, recordHits: true,
      })
      const hits = report.hits
      if (!hits || !spring.hits) throw new Error("no hits recorded")
      for (const task of ["next", "infill"] as const) {
        if (spring.hits[task].verse.join() !== hits[task].verse.join()) throw new Error("spring-2024 positions differ")
        Object.assign(hits[task].methods, spring.hits[task].methods)
        Object.assign(report[task], spring[task])
      }
      const ci = COMPARISONS.map(([task, a, b]) => {
        const h = hits[task]
        const ha = h.methods[`bia ${a}`] ?? h.methods[a]
        const hb = h.methods[`bia ${b}`] ?? h.methods[b]
        return {
          task, a, b,
          top1: pairedBootstrap(h.verse, ha, hb, 1, { resamples }),
          top3: pairedBootstrap(h.verse, ha, hb, 2, { resamples }),
        }
      })
      const row: Row = {
        pair: pair.label, size, trainCells: report.trainCells, springCells: spring.trainCells, testCells: report.testCells,
        next: strip(report.next), infill: strip(report.infill), ci,
      }
      rows.push(row)
      console.log(`\n== ${pair.label} [${size}] ${row.trainCells} train (${row.springCells} src+tgt) / ${row.testCells} test`)
      for (const task of ["next", "infill"] as const) {
        for (const [m, a] of Object.entries(row[task])) {
          console.log(`  ${task.padEnd(6)} ${m.padEnd(22)} ${(a.top1 * 100).toFixed(1).padStart(5)} / ${(a.top3 * 100).toFixed(1).padStart(5)}  ${a.ms.toFixed(2)} ms`)
        }
      }
      for (const c of ci) {
        console.log(`  CI ${c.task} ${c.a} − ${c.b}: top1 ${c.top1.diff.toFixed(1)} [${c.top1.lo.toFixed(1)}, ${c.top1.hi.toFixed(1)}] ${verdict(c.top1)}`)
      }
      writeFileSync(out, `${JSON.stringify(rows, null, 1)}\n`)
    }
  }
  console.log(`\nwrote ${out}`)
}

const pct = (x: number) => (x * 100).toFixed(1)
const ciCell = (r: BootstrapResult) => `${r.diff >= 0 ? "+" : ""}${r.diff.toFixed(1)} [${r.lo.toFixed(1)}, ${r.hi.toFixed(1)}]${verdict(r) === "real" ? " ✔" : ""}`

const SIZES = ["100", "250", "500", "1000", "2000", "full"]
/** Per-row CIs printed in full (the rest are summarised by size). */
const DECIDING: Array<["next" | "infill", string, string]> = [
  ["next", "default", "previous default"],
  ["next", "default", "BIA"],
  ["next", "default", "chains"],
  ["infill", "default", "BIA"],
  ["infill", "source", "BIA"],
  ["infill", "chains", "BIA"],
]

function render(): void {
  const files = (arg("render") ?? "").split(",").filter(Boolean)
  const rows: Row[] = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as Row[])
  const names = COLUMNS
  const head = (first: string[]) => [
    `| ${[...first, ...names].join(" | ")} |`,
    `| ${[...first.map(() => "---"), ...names.map(() => "---:")].join(" | ")} |`,
  ]
  // 1. Mean over languages, by project size.
  const means = [...head(["size", "task"])]
  for (const size of SIZES) {
    const sel = rows.filter((r) => r.size === size)
    if (sel.length === 0) continue
    for (const task of ["next", "infill"] as const) {
      const avg = (m: string, k: "top1" | "top3") => sel.reduce((t, r) => t + (r[task][m]?.[k] ?? NaN), 0) / sel.length
      const best = Math.max(...names.map((m) => avg(m, "top1")).filter((v) => !Number.isNaN(v)))
      means.push(`| ${size} | ${task} | ${names.map((m) => {
        const a = avg(m, "top1")
        if (Number.isNaN(a)) return "—"
        const cell = `${pct(a)} / ${pct(avg(m, "top3"))}`
        return a === best ? `**${cell}**` : cell
      }).join(" | ")} |`)
    }
  }
  // 2. Bootstrap verdicts by size: in how many languages each side really wins.
  const verdicts = [
    `| comparison (top-1, A − B) | ${SIZES.join(" | ")} |`,
    `| --- | ${SIZES.map(() => "---:").join(" | ")} |`,
    ...COMPARISONS.map(([task, a, b]) => `| ${task}: ${a} − ${b} | ${SIZES.map((size) => {
      const cis = rows.filter((r) => r.size === size).map((r) => r.ci.find((c) => c.task === task && c.a === a && c.b === b)?.top1)
        .filter((c): c is BootstrapResult => c !== undefined)
      if (cis.length === 0) return "—"
      const up = cis.filter((c) => c.lo > 0).length
      const down = cis.filter((c) => c.hi < 0).length
      const mean = cis.reduce((t, c) => t + c.diff, 0) / cis.length
      return `${mean >= 0 ? "+" : ""}${mean.toFixed(1)} (${up}↑ ${cis.length - up - down}= ${down}↓)`
    }).join(" | ")} |`),
  ]
  // 3. Every row.
  const lines = [...head(["pair", "size", "train / test verses", "task"])]
  for (const r of rows) {
    for (const task of ["next", "infill"] as const) {
      const best = Math.max(...Object.values(r[task]).map((a) => a.top1))
      const cells = names.map((m) => {
        const a = r[task][m]
        if (!a) return "—"
        const s = `${pct(a.top1)} / ${pct(a.top3)}`
        return a.top1 === best ? `**${s}**` : s
      })
      lines.push(`| ${r.pair} | ${r.size} | ${r.trainCells} / ${r.testCells} | ${task} | ${cells.join(" | ")} |`)
    }
  }
  // 4. Per-row CIs for the deciding comparisons.
  const ciHead = DECIDING.map(([t, a, b]) => `${t}: ${a} − ${b}`)
  const ciLines: string[] = [
    "| pair | size | " + ciHead.join(" | ") + " |",
    "| --- | --- | " + ciHead.map(() => "---:").join(" | ") + " |",
    ...rows.map((r) => `| ${r.pair} | ${r.size} | ${DECIDING.map(([t, a, b]) => {
      const c = r.ci.find((x) => x.task === t && x.a === a && x.b === b)
      return c ? ciCell(c.top1) : "—"
    }).join(" | ")} |`),
  ]
  const md = arg("md")
  const text = [
    `### Mean over the ${new Set(rows.map((r) => r.pair)).size} target languages, by project size (top-1 / top-3 %; best top-1 in bold)`,
    "",
    ...means,
    "",
    "### Paired bootstrap by size: mean top-1 difference in points, and in how many languages A is really better (↑), within noise (=), really worse (↓)",
    "",
    ...verdicts,
    "",
    "### Every language and size (top-1 / top-3 %, 1,500 positions per task; best top-1 in bold)",
    "",
    ...lines,
    "",
    "### Deciding comparisons per language: top-1 difference in points [95% CI over test verses] (✔ = CI excludes 0)",
    "",
    ...ciLines,
    "",
  ].join("\n")
  if (md) writeFileSync(md, text)
  else console.log(text)
}

if (arg("render")) render()
else run()
