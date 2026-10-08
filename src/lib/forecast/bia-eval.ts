/**
 * bia-eval.ts — offline accuracy harness for BIA forecasting.
 *
 * Pure: give it training cells and held-out texts, get next-word and infill
 * top-1 / top-3 accuracy for BIA and its baselines. `scripts/bia-eval.ts`
 * runs it over eBible corpora; `bia-eval.test.ts` runs it on a fixture.
 */

import { tokenize } from "@/lib/completion/tokenize"
import { BiaEngine, FAITHFUL_OPTIONS, type SuggestOptions } from "./bia-engine"
import { BiaIndex, type ForecastCell } from "./bia-index"

export interface Accuracy {
  top1: number
  top3: number
  /** Share of positions where the method offered anything at all. */
  coverage: number
  n: number
}

export interface EvalReport {
  trainCells: number
  testCells: number
  next: Record<string, Accuracy>
  infill: Record<string, Accuracy>
  msPerQuery: number
}

export interface EvalOptions {
  /** Cap on scored positions per task (deterministic stride sampling). */
  maxPositions?: number
}

export const FAITHFUL = "bia faithful (python: markov filter)"
export const SHIPPED = "bia shipped (decay + markov weight + fallback)"

type Predictor =(left: string[], right: string[]) => string[]

class Tally {
  private hits1 = 0
  private hits3 = 0
  private offered = 0
  private n = 0
  add(predicted: readonly string[], gold: string): void {
    this.n++
    if (predicted.length > 0) this.offered++
    if (predicted[0] === gold) this.hits1++
    if (predicted.slice(0, 3).includes(gold)) this.hits3++
  }
  result(): Accuracy {
    const d = Math.max(1, this.n)
    return { top1: this.hits1 / d, top3: this.hits3 / d, coverage: this.offered / d, n: this.n }
  }
}

/** Every (cell, position) pair, thinned to at most `max` by a fixed stride. */
function positions(tests: readonly string[][], minIndex: number, trailing: number, max: number): Array<[number, number]> {
  const all: Array<[number, number]> = []
  tests.forEach((tokens, c) => {
    for (let i = minIndex; i < tokens.length - trailing; i++) all.push([c, i])
  })
  if (all.length <= max) return all
  const stride = all.length / max
  return Array.from({ length: max }, (_, k) => all[Math.floor(k * stride)])
}

export function runForecastEval(train: readonly ForecastCell[], testTexts: readonly string[], opts: EvalOptions = {}): EvalReport {
  const index = new BiaIndex()
  index.upsert(train)
  const engine = new BiaEngine(index)
  const unigram = index.vocabularyByFrequency().slice(0, 3).map(([w]) => w)
  const tests = testTexts.map((t) => tokenize(t)).filter((t) => t.length > 1)
  const max = opts.maxPositions ?? 2000

  const bigramNext = (prev: string | undefined): string[] => {
    const followers = prev === undefined ? [] : index.followers(prev).slice(0, 3).map(([w]) => w)
    return followers.length > 0 ? followers : unigram
  }
  const bia = (o: SuggestOptions): Predictor => (left, right) =>
    (right.length === 0
      ? engine.suggestNext(`${left.join(" ")} `, { ...o, extend: false, limit: 3 })
      : engine.suggestInfill(`${left.join(" ")} `, ` ${right.join(" ")}`, { ...o, limit: 3 })
    ).map((s) => s.word)
  const biaMethods: Record<string, Predictor> = {
    [FAITHFUL]: bia(FAITHFUL_OPTIONS),
    "bia votes only (no markov)": bia({ ...FAITHFUL_OPTIONS, markov: "off" }),
    "bia + markov weight": bia({ ...FAITHFUL_OPTIONS, markov: "weight" }),
    [SHIPPED]: bia({}),
  }

  const nextMethods: Record<string, Predictor> = {
    "unigram": () => unigram,
    "bigram-markov": (left) => bigramNext(left.at(-1)),
    ...biaMethods,
  }
  const infillMethods: Record<string, Predictor> = {
    "unigram": () => unigram,
    "bigram-markov": (left, right) => {
      const prev = left.at(-1)
      const next = right[0]
      if (prev === undefined) return unigram
      const ranked = index
        .followers(prev)
        .map(([w, c]): [string, number] => [w, c * (index.bigram(w, next) + 0.01)])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([w]) => w)
      return ranked.length > 0 ? ranked : unigram
    },
    ...biaMethods,
  }

  let queries = 0
  const started = Date.now()
  const score = (methods: Record<string, Predictor>, pts: Array<[number, number]>, infill: boolean) => {
    const out: Record<string, Accuracy> = {}
    for (const [name, predict] of Object.entries(methods)) {
      const tally = new Tally()
      for (const [c, i] of pts) {
        const tokens = tests[c]
        const predicted = predict(tokens.slice(0, i), infill ? tokens.slice(i + 1) : [])
        if (name.startsWith("bia")) queries++
        tally.add(predicted, tokens[i])
      }
      out[name] = tally.result()
    }
    return out
  }
  const next = score(nextMethods, positions(tests, 1, 0, max), false)
  const infill = score(infillMethods, positions(tests, 1, 1, max), true)
  return {
    trainCells: index.size,
    testCells: tests.length,
    next,
    infill,
    msPerQuery: queries > 0 ? (Date.now() - started) / queries : 0,
  }
}

/** Split vref-aligned verse lines into train cells and held-out texts (every `k`th verse). */
export function splitHeldOut(lines: readonly string[], k = 10, trainLimit?: number): { train: ForecastCell[]; test: string[] } {
  const train: ForecastCell[] = []
  const test: string[] = []
  let kept = 0
  lines.forEach((line, i) => {
    const text = line.trim()
    if (!text) return
    if (kept++ % k === k - 1) test.push(text)
    else if (trainLimit === undefined || train.length < trainLimit) {
      train.push({ id: `v${i}`, text, validated: true, order: i })
    }
  })
  return { train, test }
}
