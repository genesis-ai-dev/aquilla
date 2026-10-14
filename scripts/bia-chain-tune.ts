// Tune the next-word chain weighting of the source mix on DEV data only.
//
//   pnpm bia:tune-chains [-- --pairs <target substring>,... --sizes 100,250,500,1000,2000
//                            --positions 600 --dev 250 --forms soft-product,soft-sum,soft-lift
//                            --scales 1,10,100 --alphas 1,2 --out results.json]
//   pnpm bia:tune-chains -- --render a.json,b.json [--md docs/forecast/bia-chain-tuning-dev.md]
//
// The eval's TEST verses (every 10th) are never touched. A project of size N
// indexes its first N TRAINING pairs and is scored on the next `dev` training
// pairs — the verses a team would translate next. Only the low-resource
// pairs drive tuning (scripts/bia-parallel-pairs.ts); the other languages are
// checked on the test split afterwards by scripts/bia-head-to-head.ts.

import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { runForecastEval, splitParallel } from "../src/lib/forecast/bia-eval"
import type { ChainForm, SuggestOptions } from "../src/lib/forecast/bia-engine"
import { AGNOSTIC_PAIRS, PARALLEL_PAIRS } from "./bia-parallel-pairs"

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const list = (name: string, fallback: string) => (arg(name) ?? fallback).split(",")
const FORMS = list("forms", "soft-product,soft-sum") as ChainForm[]
const SCALES = list("scales", "1,3,10,30,100,300,1000,10000").map(Number)
const ALPHAS = list("alphas", "1,2,4").map(Number)
/** Where the chain weight applies with a source (SuggestOptions.chainStage). */
const STAGES = list("stages", "final") as Array<"final" | "target">

export function variants(): Record<string, SuggestOptions> {
  const out: Record<string, SuggestOptions> = {
    "BIA": { sourceWeight: 0, chains: false },
    "chains": { sourceWeight: 0, chains: true, chainsOnly: true },
    // Explicit α and stage: the baselines must not follow the shipped default.
    "source (bigram)": { chains: false, sourceWeight: 2, sourceMinPairs: 0 },
    "source + chains (product)": { chains: true, chainsOnly: false, chainForm: "product", chainStage: "final", sourceWeight: 2, sourceMinPairs: 0 },
  }
  // The bigram-weighted source mix at other mixing weights (α = 2 ships).
  for (const alpha of list("bigram-alphas", "").filter(Boolean).map(Number)) {
    out[`source (bigram) a=${alpha}`] = { chains: false, sourceWeight: alpha, sourceMinPairs: 0 }
  }
  for (const stage of STAGES) {
    const tag = stage === "target" ? "target-stage " : ""
    for (const form of FORMS) {
      // The product form has no scale.
      for (const scale of form === "product" ? [1] : SCALES) {
        for (const alpha of ALPHAS) {
          const name = `${tag}${form}${form === "product" ? "" : ` s=${scale}`} a=${alpha}`
          out[name] = {
            chains: true, chainsOnly: false, chainForm: form, chainScale: scale, chainStage: stage, sourceWeight: alpha, sourceMinPairs: 0,
          }
          if (stage === "target" && form === "product") {
            out[`${name} chains-only`] = { ...out[name], chainsOnly: true }
          }
        }
      }
    }
  }
  return out
}

interface Row { pair: string; size: number; next: Record<string, { top1: number; top3: number; n: number }> }

function run(): void {
  const dir = arg("corpus-dir") ?? process.env.EBIBLE_CORPUS_DIR ?? resolve(homedir(), "Frontier/EBibleBenchmarks/corpus")
  const sizes = (arg("sizes") ?? "100,250,500,1000,2000").split(",").map(Number)
  const maxPositions = Number(arg("positions") ?? 600)
  const devCount = Number(arg("dev") ?? 250)
  const which = arg("pairs")
  const pool = [...PARALLEL_PAIRS, ...AGNOSTIC_PAIRS]
  const pairs = which
    ? pool.filter((p) => which.split(",").some((s) => p.target.includes(s) || p.label.includes(s)))
    : PARALLEL_PAIRS.filter((p) => p.lowResource)
  const out = arg("out") ?? "bia-chain-tune.json"
  const rows: Row[] = []
  for (const pair of pairs) {
    const src = readFileSync(resolve(dir, pair.source), "utf8").split("\n")
    const tgt = readFileSync(resolve(dir, pair.target), "utf8").split("\n")
    const { train } = splitParallel(src, tgt, 10)
    for (const size of sizes) {
      const dev = train.slice(size, size + devCount).map((c) => ({ text: c.text, source: c.source }))
      const report = runForecastEval(train.slice(0, size), dev, {
        maxPositions, methods: "variants", variants: variants(), infillVariants: [],
      })
      const next = Object.fromEntries(Object.entries(report.next).map(([k, v]) => [k.replace(/^bia /, ""), { top1: v.top1, top3: v.top3, n: v.n }]))
      rows.push({ pair: pair.label, size, next })
      const best = Object.entries(next).sort((a, b) => b[1].top1 - a[1].top1).slice(0, 3)
      console.log(`${pair.label} [${size}] best: ${best.map(([k, v]) => `${k} ${(v.top1 * 100).toFixed(1)}`).join(" | ")}`)
      writeFileSync(out, `${JSON.stringify(rows)}\n`)
    }
  }
}

function render(): void {
  const rows: Row[] = (arg("render") ?? "").split(",").filter(Boolean).flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as Row[])
  const names = Object.keys(rows[0]?.next ?? {})
  const sizes = [...new Set(rows.map((r) => r.size))].sort((a, b) => a - b)
  const mean = (m: string, sel: Row[], k: "top1" | "top3") => (100 * sel.reduce((t, r) => t + r.next[m][k], 0)) / sel.length
  const ranked = names
    .map((m) => ({ m, all: mean(m, rows, "top1"), all3: mean(m, rows, "top3"), by: sizes.map((s) => mean(m, rows.filter((r) => r.size === s), "top1")) }))
    .sort((a, b) => b.all - a.all)
  const lines = [
    "# Next-word chain weighting of the source mix — tuning on dev (never the test split)",
    "",
    "Generated by `pnpm bia:tune-chains`. A project of size N indexes its first N training pairs and is scored on",
    "the next 250 training pairs (600 next-word positions); low-resource pairs only. Mean top-1 % over pairs.",
    "`s` = chainScale, `a` = sourceWeight (α). Sorted by the mean over every size.",
    "",
    `| variant | mean top-1 | mean top-3 | ${sizes.map((s) => `${s} pairs`).join(" | ")} |`,
    `| --- | ---: | ---: | ${sizes.map(() => "---:").join(" | ")} |`,
    ...ranked.map((r) => `| ${r.m} | ${r.all.toFixed(2)} | ${r.all3.toFixed(2)} | ${r.by.map((v) => v.toFixed(1)).join(" | ")} |`),
    "",
  ]
  const md = arg("md")
  if (md) writeFileSync(md, lines.join("\n"))
  else console.log(lines.join("\n"))
}

if (arg("render")) render()
else run()
