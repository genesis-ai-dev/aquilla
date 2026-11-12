// Walk one real next-word suggestion through the DEFAULT source-aware path
// (chooseGuesser), printing the actual intermediate values from the engine's
// own code (not a re-implementation): the BIA vote, its per-distance chain
// weight, the source lexicon's per-source-word contributions, the mix, and the
// bigram weight. The last step is checked against BiaEngine.suggestNext, so
// the trace cannot drift from what the editor computes.
//
//   pnpm bia:explain [-- --target tpi-tpi.txt --limit 2000 --pick right|wrong --nth 0]
//
// Picks a held-out position where the default CHANGES the top-1 next word
// versus plain BIA and the new word is right (--pick right) or wrong.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { splitParallel } from "../src/lib/forecast/bia-eval"
import {
  BiaEngine, CHAIN_SCALE, NEXT_SOURCE_WEIGHT, SOURCE_LAMBDA, SOURCE_POWER, SOURCE_TARGET_IDF, mixScores, type ChainForm, type Ranked,
} from "../src/lib/forecast/bia-engine"
import { BiaIndex } from "../src/lib/forecast/bia-index"
import { COVERED_PENALTY } from "../src/lib/forecast/source-lexicon"
import { fold, wordKeys } from "../src/lib/forecast/forecast-tokenize"

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const dir = arg("corpus-dir") ?? process.env.EBIBLE_CORPUS_DIR ?? resolve(homedir(), "Frontier/EBibleBenchmarks/corpus")
const target = arg("target") ?? "tpi-tpi.txt"
const limit = arg("limit") === "full" ? undefined : Number(arg("limit") ?? 2000)
const pick = arg("pick") ?? "right"
const nth = Number(arg("nth") ?? 0)

const srcLines = readFileSync(resolve(dir, "eng-engwebp.txt"), "utf8").split("\n")
const tgtLines = readFileSync(resolve(dir, target), "utf8").split("\n")
const vref = readFileSync(resolve(dir, "vref.txt"), "utf8").split("\n")
const { train, test } = splitParallel(srcLines, tgtLines, 10, limit)
const heldOut = limit === undefined ? test : test.slice(0, Math.ceil(2000 / 9))
const index = new BiaIndex()
index.upsert(train)
const engine = new BiaEngine(index)
const lineOf = new Map(tgtLines.map((l, i) => [l.trim(), i]))
const ref = (id: string) => vref[Number(id.slice(1))] ?? id
const top = (r: Ranked, n = 5) => r.slice(0, n).map(([w, s]) => `${w} ${s.toFixed(3)}`).join(", ")
const f3 = (x: number) => x.toFixed(3)

const base = { extend: false, limit: 3 } as const
const plain = (left: string[]) => engine.suggestNext(`${left.join(" ")} `, { ...base, sourceWeight: 0, chains: false }).map((s) => fold(s.word))
const withSource = (left: string[], source: string) => engine.suggestNext(`${left.join(" ")} `, { ...base, source }).map((s) => fold(s.word))
type Markov = (r: Ranked, p: string | undefined, n: string | undefined, m: string, l: number,
  c?: { left: readonly string[]; right: readonly string[] }, shape?: { form: ChainForm; scale: number }) => Ranked
const markov = (engine as unknown as { markov: Markov }).markov.bind(engine)

// 1. Find the example.
let found: { left: string[]; gold: string; text: string; source: string } | undefined
let seen = 0
outer: for (const item of heldOut) {
  const tokens = wordKeys(item.text)
  for (let i = 1; i < tokens.length; i++) {
    const left = tokens.slice(0, i)
    const a = plain(left)[0]
    const b = withSource(left, item.source)[0]
    if (a === b) continue
    const ok = pick === "right" ? b === tokens[i] && a !== tokens[i] : a === tokens[i] && b !== tokens[i]
    if (!ok || seen++ < nth) continue
    found = { left, gold: tokens[i], text: item.text, source: item.source }
    break outer
  }
}
if (!found) throw new Error("no example found")
const { left, gold, source } = found
const at = lineOf.get(found.text)
console.log(`# ${pick === "right" ? "Source changes the answer and gets it RIGHT" : "Source changes the answer and gets it WRONG"}`)
console.log(`Eval set: eng→${target} ${limit ?? "full"} training pairs (${index.size} cells, ${index.lexicon.pairCount} source/target pairs); held-out verse ${at !== undefined ? vref[at] : "?"}`)
console.log(`Source verse: ${source}`)
console.log(`Target verse: ${found.text}`)
console.log(`Typed so far: "${left.join(" ")}"  → the next word is "${gold}"`)

// 2. Target side: the BIA vote, with its anchors captured from the real lookups.
const anchorCalls: string[] = []
const original = index.postingsOf.bind(index)
index.postingsOf = (word: string) => {
  anchorCalls.push(word)
  return original(word)
}
const bia = engine.predictAt([...left, ""], left.length, { decay: 1 })
index.postingsOf = original
console.log(`\n## Step 1 — target side (BIA vote over ${index.size} validated verses)`)
console.log(`Anchors looked up (rarest first, distance from the blank, IDF): ${anchorCalls.map((w) => `${w} (d=${left.lastIndexOf(w) - left.length}, idf ${index.idf(w).toFixed(2)})`).join(", ")}`)
console.log(`Top BIA votes: ${top(bia)}`)

// 2b. The per-distance chains weight the target-side guess (soft-sum).
const chained = markov(bia, left.at(-1), undefined, "weight", 3, { left, right: [] }, { form: "soft-sum", scale: CHAIN_SCALE })
console.log(`\n## Step 1b — chain weight on the BIA vote: × (1 + ln(1 + ${CHAIN_SCALE} · Σ_k P_k(w | word k back) / k))`)
const back = left.slice(-3).reverse()
for (const w of [...new Set([gold, plain(left)[0]])]) {
  const ps = back.map((ctx, k) => index.chainProbability(k + 1, ctx, w))
  const sum = ps.reduce((t, p, k) => t + p / (k + 1), 0)
  console.log(`  "${w}": ${back.map((ctx, k) => `P_${k + 1}(${w} | ${ctx}) = ${ps[k].toFixed(3)}`).join(", ")} → factor ${(1 + Math.log1p(CHAIN_SCALE * sum)).toFixed(2)}`)
}
console.log(`Top chain-weighted votes: ${top(chained)}`)

// 3. Source side.
const srcTokens = wordKeys(source)
const lex = index.lexicon
const ratio = lex.lengthRatio
const expected = Math.max(left.length + 1, srcTokens.length * ratio)
const cursor = (left.length + 0.5) / expected
console.log(`\n## Step 2 — source side (lexicon from ${lex.pairCount} verse pairs)`)
console.log(`Source words: ${srcTokens.join(" ")}`)
console.log(`Target/source length ratio ${ratio.toFixed(2)} → expected target length ${expected.toFixed(1)} words; cursor at relative position ${f3(cursor)}`)
const aligned = lex.scoreTargets(srcTokens, { left, right: [], lambda: SOURCE_LAMBDA, power: SOURCE_POWER, stemWeight: 0 })
const contributions = (t: string) => srcTokens.map((s, i) => {
  const dice = lex.dice(s, t)
  const posW = Math.exp(-SOURCE_LAMBDA * Math.abs((i + 0.5) / srcTokens.length - cursor))
  const idf = lex.idf(s, lex.pairCount)
  const covered = left.includes(t) ? COVERED_PENALTY : 1
  return { s, i, dice, posW, idf, value: idf * dice ** SOURCE_POWER * posW * covered }
}).filter((c) => c.value > 0).sort((a, b) => b.value - a.value)
const coCounts = (s: string, t: string) => {
  let both = 0, sOnly = 0, tOnly = 0
  const refs: string[] = []
  for (const c of train) {
    const hasS = wordKeys(c.source ?? "").includes(s)
    const hasT = wordKeys(c.text).includes(t)
    if (hasS && hasT) { both++; if (refs.length < 3) refs.push(ref(c.id)) }
    else if (hasS) sOnly++
    else if (hasT) tOnly++
  }
  return { both, sOnly, tOnly, refs }
}
const plainTop = plain(left)[0]
const sourceTop = withSource(left, source)[0]
for (const t of [gold, plainTop, sourceTop].filter((w, k, all) => all.indexOf(w) === k)) {
  const cs = contributions(t)
  console.log(`\nTarget candidate "${t}": source score ${f3(aligned.get(t) ?? 0)} = Σ idf(s) · Dice(s,t)^${SOURCE_POWER} · position weight${left.includes(t) ? ` · ${COVERED_PENALTY} (already typed)` : ""}`)
  for (const c of cs.slice(0, 4)) {
    const k = coCounts(c.s, t)
    console.log(`  "${c.s}" (source word ${c.i + 1}/${srcTokens.length}): verses with "${c.s}" in source AND "${t}" in target ${k.both}, "${c.s}" only ${k.sOnly}, "${t}" only ${k.tOnly} → Dice ${f3(c.dice)}; idf ${c.idf.toFixed(2)}; position weight ${f3(c.posW)} → ${f3(c.value)}  (e.g. ${k.refs.join(", ")})`)
  }
  if (cs.length === 0) console.log("  (no source word is associated with it)")
}
for (const [t, v] of aligned) aligned.set(t, v * index.idf(t) ** SOURCE_TARGET_IDF)
const alignedTop = Array.from(aligned.entries()).sort((a, b) => b[1] - a[1])
console.log(`\n## Step 3 — × target-word IDF^${SOURCE_TARGET_IDF} (content words speak, function words are left to context)`)
console.log(`Top source scores: ${top(alignedTop)}`)
console.log(`  "${gold}": idf ${index.idf(gold).toFixed(2)}${plainTop !== gold ? `; "${plainTop}": idf ${index.idf(plainTop).toFixed(2)}` : ""}`)

// 4. Mix and Markov / chains, through the engine's own functions.
const mixed = engine.rank(mixScores(chained, aligned, NEXT_SOURCE_WEIGHT, "add"))
console.log(`\n## Step 4 — mix: chained/max(chained) + ${NEXT_SOURCE_WEIGHT} × source/max(source)`)
console.log(`Top mixed: ${top(mixed)}`)
const final = markov(mixed, left.at(-1), undefined, "weight", 3)
console.log(`\n## Step 5 — bigram weight × (1 + ln(1 + count("${left.at(-1)}" → w)))`)
for (const w of [gold, plainTop]) console.log(`  count("${left.at(-1)}" → "${w}") = ${index.bigram(left.at(-1) ?? "", w)}`)
console.log(`Final ranking: ${top(final)}`)
const engineSays = withSource(left, source)
console.log(`\nBiaEngine.suggestNext with the source: ${engineSays.join(", ")}   (plain BIA: ${plain(left).join(", ")})`)
if (fold(final[0][0]) !== engineSays[0]) throw new Error("trace disagrees with suggestNext")
console.log(`Gold: ${gold} → source-aware is ${engineSays[0] === gold ? "RIGHT" : "WRONG"}, plain BIA is ${plain(left)[0] === gold ? "RIGHT" : "WRONG"}`)
