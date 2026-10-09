// Tune the source-alignment mix for BIA on DEV data only.
//
//   pnpm bia:tune-source [-- --positions 400 --alphas 0.5,1 --lambdas 8,16
//                            --mixes add,boost --powers 1,2 --idfs 0,1 --stems 0,4 --betas 0,1
//                            --slices early|all --all-pairs yes --out file.md]
//
// Only the LOW-RESOURCE pairs (scripts/bia-parallel-pairs.ts) drive tuning by
// default; Spanish→English is a reference, never a tuning target.
//
// For each parallel pair and slice, the eval's TEST verses (every 10th) are
// never touched: the training verses are split again (every 10th → dev), the
// index is built from the rest, and a grid of (alpha, lambda) is scored on dev.
// The grid point with the best mean of next/infill top-1/top-3 across every
// pair and slice is printed; bia-engine.ts's SOURCE_WEIGHT / SOURCE_LAMBDA
// are set from it. Output: docs/forecast/bia-source-tuning*.md (round1: alpha x lambda; round2-4 on the
// first-2000 dev splits: Dice power, add vs boost mixing, target-IDF exponent).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { devSplit, runForecastEval, splitParallel } from "../src/lib/forecast/bia-eval"
import type { SourceMix, SuggestOptions } from "../src/lib/forecast/bia-engine"
import { PARALLEL_PAIRS, SLICES } from "./bia-parallel-pairs"

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const dir = arg("corpus-dir") ?? process.env.EBIBLE_CORPUS_DIR ?? resolve(homedir(), "Frontier/EBibleBenchmarks/corpus")
const maxPositions = Number(arg("positions") ?? 400)
const list = (name: string, fallback: string) => (arg(name) ?? fallback).split(",")
const ALPHAS = list("alphas", "0,0.25,0.5,1,2,4").map(Number)
const LAMBDAS = list("lambdas", "0,2,4,8").map(Number)
const MIXES = list("mixes", "add") as SourceMix[]
const POWERS = list("powers", "1").map(Number)
const IDFS = list("idfs", "0").map(Number)
const STEMS = list("stems", "0").map(Number)
const BETAS = list("betas", "0").map(Number)
// Next-word chains (Daniel's 2024 per-distance forecaster): 0 off, 1 on, only = chains without BIA.
const CHAINS = list("chains", "0")
const chainOpts = (c: string): SuggestOptions => (c === "0" ? { chains: false } : c === "1" ? { chains: true } : { chains: true, chainsOnly: true })
// Low-resource targets only, unless asked: they are who the tool is for.
const pairs = arg("all-pairs") === "yes" ? PARALLEL_PAIRS : PARALLEL_PAIRS.filter((p) => p.lowResource)
const slices = arg("slices") === "early" ? SLICES.filter(([, limit]) => limit !== undefined) : arg("slices") === "full" ? SLICES.filter(([, limit]) => limit === undefined) : SLICES
const outName = arg("out") ?? "bia-source-tuning.md"

const variants: Record<string, SuggestOptions> = {}
for (const c of CHAINS) {
  variants[`no source c=${c}`] = { sourceWeight: 0, ...chainOpts(c) }
  for (const mix of MIXES) for (const p of POWERS) for (const q of IDFS) for (const a of ALPHAS) for (const l of LAMBDAS) for (const b of BETAS) {
    if (a === 0) continue
    variants[`${mix} a=${a} l=${l} p=${p} q=${q} c=${c} b=${b}`] = {
      sourceWeight: a, sourceLambda: l, sourceMix: mix, sourcePower: p, sourceTargetIdf: q, sourceStemWeight: b, ...chainOpts(c),
    }
  }
}

const totals = new Map<string, number[]>()
const rows: string[] = []
for (const pair of pairs) {
  const src = readFileSync(resolve(dir, pair.source), "utf8").split("\n")
  const tgt = readFileSync(resolve(dir, pair.target), "utf8").split("\n")
  for (const [slice, limit] of slices) {
    const { train } = splitParallel(src, tgt, 10, limit)
    const { train: fit, dev } = devSplit(train, 10)
    for (const stem of STEMS) {
      // The stem length is an index property: one index per length.
      const report = runForecastEval(fit, dev, { maxPositions, methods: "variants", variants, index: { stemGraphemes: stem } })
      for (const base of Object.keys(variants)) {
        // Stem length only matters when the stem back-off is on.
        if (stem !== STEMS[0] && !/b=(?!0$)/.test(base)) continue
        const name = /b=(?!0$)/.test(base) ? `${base} k=${stem}` : base
        const n = report.next[`bia ${base}`]
        const f = report.infill[`bia ${base}`]
        const mean = (n.top1 + n.top3 + f.top1 + f.top3) / 4
        totals.set(name, [...(totals.get(name) ?? []), mean])
        rows.push(`| ${pair.label} | ${slice} | ${name} | ${(n.top1 * 100).toFixed(1)} | ${(n.top3 * 100).toFixed(1)} | ${(f.top1 * 100).toFixed(1)} | ${(f.top3 * 100).toFixed(1)} |`)
      }
    }
    console.log(`tuned ${pair.label} ${slice} (${fit.length} fit / ${dev.length} dev)`)
  }
}

const ranked = Array.from(totals.entries())
  .map(([name, means]) => [name, means.reduce((a, b) => a + b, 0) / means.length] as const)
  .sort((a, b) => b[1] - a[1])
for (const [name, mean] of ranked) console.log(`${name.padEnd(12)} mean ${(mean * 100).toFixed(2)}`)

const out = resolve(import.meta.dirname, "../docs/forecast")
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, outName), [
  "# BIA source mix — tuning on dev (never the test split)",
  "",
  `Generated by \`pnpm bia:tune-source\`; ${maxPositions} dev positions per task. Mean of next/infill top-1/top-3 over all pairs and slices:`,
  "",
  "| variant | mean |", "| --- | ---: |",
  ...ranked.map(([name, mean]) => `| ${name} | ${(mean * 100).toFixed(2)}% |`),
  "",
  "| pair | slice | variant | next top-1 | next top-3 | infill top-1 | infill top-3 |",
  "| --- | --- | --- | ---: | ---: | ---: | ---: |",
  ...rows,
  "",
].join("\n"))
console.log(`best: ${ranked[0][0]}`)
