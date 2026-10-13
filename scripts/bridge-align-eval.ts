// Bridge 1/2 alignment evaluation (AQU-1694).
//
// Measures how well the pack's Greek words can be aligned to a project's
// source text (Bridge 1), and through it to a target text (Bridges 1+2),
// against Clear-Bible's manual alignments (CC BY 4.0). It is the evidence for
// what Who's Who ships: which aligner, and below what confidence a tint draws
// dotted ("approximate"). Re-run it when the aligner or the pack changes.
//
// Candidates (all trained on the evaluated book only, like the product, unless
// --train nt):
//   A  completion/interlinear.ts on Greek surface forms (Dice < 50 pairs, else its EM)
//   B  the same on Greek lemmas
//   C  A + the Who's Who constraints: proper noun → similar capitalized word
//      (name-match.ts), and duplicate target words re-routed to keep the order
//      monotonic between confident anchors
//   D  bible-data/word-align.ts: IBM-1 both ways + grow-diag-final-and, frequent
//      surface forms else lemmas
//   v1 D + the proper-noun constraint: bible-data/source-alignment.ts, what ships
//
// Usage:
//   pnpm bridges:eval --data <dir> --pack <dir> [--book JHN] [--text BSB] [--train book|nt]
//                     [--compose YLT] [--sweep MRK] [--json] [--write-fixture]
//
// --data: a checkout of https://github.com/Clear-Bible/Alignments (or a folder
//   holding SBLGNT-<TEXT>-manual.json and nt_<TEXT>.tsv). The two BSB files are
//   data/eng/alignments/BSB/SBLGNT-BSB-manual.json and data/eng/targets/BSB/nt_BSB.tsv.
// --pack: a Bible Knowledge Pack v1 folder with text/ and people/ (bible-wiki
//   content/bkp/v1, or a download of https://bibletranslation.org/bkp/v1/).
// --compose YLT: also score Bridges 1+2 (Greek → TEXT → YLT) against SBLGNT→YLT,
//   with Bridge 2 trained on 25, 50, 120, 300 and all of the book's verses.
// --sweep MRK: tune the aligner's settings on another book (never the one reported).
// --write-fixture: refresh src/lib/bible-data/__fixtures__/bridge-jhn4.json (BSB, JHN only).
//
// An OT book (AQU-1700, pack 1.2.0) reads data/eng/alignments/BSB/WLCM-BSB-manual.json
// (Macula Hebrew morpheme ids) and data/eng/targets/BSB/ot_BSB.tsv instead, e.g.
//   pnpm bridges:eval --data … --pack … --book RUT --text BSB
// Its "pronoun" class includes the pronominal suffixes.
//
// The AQU-1694 numbers came from (pack 1.1.0, Node 22):
//   pnpm bridges:eval --data … --pack … --book JHN --text BSB --compose YLT
//   pnpm bridges:eval --data … --pack … --book JHN --text BSB --sweep MRK
//   pnpm bridges:eval --data … --pack … --book <each NT book> --text BSB
// French (LSG) is not usable as gold as published: its target TSV splits
// "Donne-moi" into three tokens where the alignment counted fewer, so token
// ids drift after hyphens and elisions (JHN 4:7: πεῖν → "moi").
//
// Not run here: Clear/BibleAquifer `text-align` (LLM alignment, MIT). It
// costs a model call per verse. It would plug in as another writer of the
// same rows: run it per book on the server (or in the agent sandbox), map its
// Macula-id ↔ token output to `source_word_alignment` rows with its own
// `method` ("text-align/<model>") and a confidence from its scoring step,
// and Who's Who reads them unchanged. Measure it with this script first:
// add a candidate that reads its output instead of training.

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { alignCell, buildAlignmentModel } from "../src/lib/completion/interlinear"
import { tokenSpans, tokenize } from "../src/lib/completion/tokenize"
import type { BkpTextLayer, BkpWord } from "../src/lib/bible-data/pack-types"
import { addNameLinks, alignSourceBook, greekTokens } from "../src/lib/bible-data/source-alignment"
import { alignWords, trainWordAlignModel, type AlignLink } from "../src/lib/bible-data/word-align"
import { composeBridges, TINT_SOLID_MIN } from "../src/lib/bible-data/bridge-compose"
import {
  bookNumber,
  clearFiles,
  loadGold,
  loadMentionKinds,
  loadPackText,
  loadTargetText,
  NT_BOOKS,
  testamentOf,
  type GreekVerse,
  type TextVerse,
} from "./lib/bridge-eval-data"
import { bandPrecision, CLASSES, createScorer, precisionByConfidence, scoreRow, type PredictedLink } from "./lib/bridge-eval-score"

const { values: args } = parseArgs({
  options: {
    data: { type: "string" },
    pack: { type: "string" },
    book: { type: "string", default: "JHN" },
    text: { type: "string", default: "BSB" },
    train: { type: "string", default: "book" },
    compose: { type: "string" },
    sweep: { type: "string" },
    json: { type: "boolean", default: false },
    "write-fixture": { type: "boolean", default: false },
  },
})

if (!args.data || !args.pack) {
  console.error("Usage: pnpm bridges:eval --data <Clear-Bible/Alignments checkout> --pack <bkp/v1 folder> [--book JHN] [--text BSB]")
  console.error("Get the data: git clone --depth 1 https://github.com/Clear-Bible/Alignments (files are plain JSON/TSV)")
  process.exit(2)
}

const book = args.book
// AQU-1700: an OT book reads Clear's WLCM (Macula Hebrew) alignment and ot_<TEXT>.tsv.
const testament = testamentOf(book)
if (testament === "ot" && args.train === "nt") throw new Error("--train nt trains on the NT: use --train book for an OT book")
const files = clearFiles(args.data, args.text, testament)
const greekAll = loadPackText(args.pack, args.train === "nt" ? NT_BOOKS : [book])
const textAll = loadTargetText(files.tsv)
const gold = loadGold(files.alignment, book)
const mentions = loadMentionKinds(args.pack, book)
const prefix = bookNumber(book)
const keysAll = [...greekAll.keys()].filter((key) => textAll.has(key)).sort()
const evalKeys = keysAll.filter((key) => key.startsWith(prefix))
const trainKeys = args.train === "nt" ? keysAll : evalKeys
const manifest = JSON.parse(readFileSync(path.join(args.pack, "manifest.json"), "utf8")) as { version: string; builtAt: string }
const report: Record<string, unknown> = {
  book,
  text: args.text,
  train: args.train,
  trainPairs: trainKeys.length,
  pack: { version: manifest.version, builtAt: manifest.builtAt },
}
if (!args.json) console.log(`pack ${manifest.version} (built ${manifest.builtAt}); ${book} on ${args.text}; trained on ${args.train} (${trainKeys.length} verse pairs)`)

/** A layer holding the given verses, for alignSourceBook. */
function layerOf(keys: readonly string[]): BkpTextLayer {
  const layer: BkpTextLayer = { book, verses: {}, words: {} }
  for (const key of keys) {
    const verse = greekAll.get(key)!
    layer.verses[`${key}`] = verse.ids
    verse.ids.forEach((id, k) => (layer.words[id] = verse.words[k]))
  }
  return layer
}

const surface = (word: BkpWord) => tokenize(word.text).join("") || "x"
const lemma = (word: BkpWord) => tokenize(word.lemma).join("") || "x"

type Linker = (verse: GreekVerse, text: TextVerse) => AlignLink[]

/** Time, retained heap after, and peak heap during (sampled by `sample`, which the build calls). */
function measure<T>(build: (sample: () => void) => T): { value: T; ms: number; mb: number; peakMb: number } {
  globalThis.gc?.()
  const before = process.memoryUsage().heapUsed
  let peak = before
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage().heapUsed)
  }
  const start = performance.now()
  const value = build(sample)
  const ms = performance.now() - start
  sample()
  globalThis.gc?.()
  return { value, ms, mb: (process.memoryUsage().heapUsed - before) / 1e6, peakMb: (peak - before) / 1e6 }
}

function interlinearLinker(form: (word: BkpWord) => string): { linker: Linker; ms: number; mb: number; peakMb: number } {
  // interlinear.ts has no progress hook: its "peak" is the heap right after training, before GC.
  const built = measure(() =>
    buildAlignmentModel(trainKeys.map((key) => ({ source: greekAll.get(key)!.words.map(form).join(" "), target: textAll.get(key)!.text }))),
  )
  const linker: Linker = (verse, text) =>
    alignCell(verse.words.map(form).join(" "), text.text, built.value).map((link) => ({
      src: link.srcIndex,
      tgt: link.tgtIndex,
      conf: link.confidence,
    }))
  return { linker, ms: built.ms, mb: built.mb, peakMb: built.peakMb }
}

/** The not-shipped half of C: a low-confidence link to a repeated word moves to the copy nearest its expected place. */
function monotonic(text: TextVerse, links: AlignLink[], sourceLength: number): AlignLink[] {
  const tokens = tokenize(text.text)
  const copies = new Map<string, number[]>()
  tokens.forEach((token, j) => copies.set(token, [...(copies.get(token) ?? []), j]))
  const anchors = links.filter((link) => link.conf >= 0.5 && copies.get(tokens[link.tgt])!.length === 1).sort((a, b) => a.src - b.src)
  const expected = (i: number) => {
    const left = [...anchors].reverse().find((a) => a.src <= i)
    const right = anchors.find((a) => a.src > i)
    if (left && right) return left.tgt + ((right.tgt - left.tgt) * (i - left.src)) / Math.max(1, right.src - left.src)
    const ratio = tokens.length / sourceLength
    return left ? left.tgt + (i - left.src) * ratio : right ? right.tgt - (right.src - i) * ratio : (i + 0.5) * ratio
  }
  const taken = new Set(links.map((link) => link.tgt))
  return links.map((link) => {
    const where = copies.get(tokens[link.tgt])!
    if (where.length < 2 || link.conf >= 0.5) return link
    const e = expected(link.src)
    const best = where.reduce((a, b) => (Math.abs(b - e) < Math.abs(a - e) && !taken.has(b) ? b : a), link.tgt)
    taken.delete(link.tgt)
    taken.add(best)
    return { ...link, tgt: best }
  })
}

function score(name: string, linker: Linker, measured?: { ms: number; mb: number; peakMb: number }) {
  const cost = measured ? { ms: measured.ms, mb: measured.mb, peakMb: measured.peakMb } : undefined
  const scorer = createScorer(gold, mentions)
  for (const key of evalKeys) {
    const verse = greekAll.get(key)!
    const text = textAll.get(key)!
    const links = linker(verse, text)
    scorer.add(verse.ids, verse.words, links.map((link) => ({ wordId: verse.ids[link.src], targetId: text.ids[link.tgt], conf: link.conf })))
  }
  const result = {
    name,
    cost,
    scores: scorer.scores,
    precisionByConfidence: Object.fromEntries(
      CLASSES.map((c) => [c, precisionByConfidence(scorer.confidences[c], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])]),
    ),
    solidBand: Object.fromEntries(CLASSES.map((c) => [c, bandPrecision(scorer.confidences[c], TINT_SOLID_MIN, 2)])),
    dottedBand: Object.fromEntries(CLASSES.map((c) => [c, bandPrecision(scorer.confidences[c], 0, TINT_SOLID_MIN)])),
  }
  if (!args.json) {
    console.log(`\n== ${name}${cost ? `   (train ${cost.ms.toFixed(0)} ms, peak heap +${cost.peakMb.toFixed(0)} MB, retained +${cost.mb.toFixed(0)} MB)` : ""}`)
    for (const c of CLASSES) console.log(`  ${c.padEnd(13)} ${scoreRow(scorer.scores[c])}`)
    for (const c of ["pronoun", "subject-verb", "proper", "mention"] as const) {
      const row = result.precisionByConfidence[c].map((p) => `≥${p.min}: ${p.precision === null ? "-" : (100 * p.precision).toFixed(1)}`)
      console.log(`  precision by confidence, ${c.padEnd(12)} ${row.join("  ")}`)
    }
  }
  return result
}

const results: unknown[] = []
const A = interlinearLinker(surface)
results.push(score("A interlinear.ts, surface", A.linker, A))
const B = interlinearLinker(lemma)
results.push(score("B interlinear.ts, lemma", B.linker, B))
results.push(
  score("C A + names + monotonic", (verse, text) =>
    monotonic(text, addNameLinks(verse.words, tokenSpans(text.text), A.linker(verse, text)), verse.words.length),
  ),
)

// D and v1 share the hybrid Greek tokens of source-alignment.ts.
const counts = new Map<string, number>()
for (const key of trainKeys) for (const word of greekAll.get(key)!.words) counts.set(surface(word), (counts.get(surface(word)) ?? 0) + 1)
const D = measure((sample) =>
  trainWordAlignModel(
    trainKeys.map((key) => ({ src: greekTokens(greekAll.get(key)!.words, counts), tgt: tokenize(textAll.get(key)!.text) })),
    { onProgress: sample },
  ),
)
const dLinker: Linker = (verse, text) => alignWords(D.value!, greekTokens(verse.words, counts), tokenize(text.text))
results.push(score("D word-align.ts (IBM-1 both ways, GDFA)", dLinker, D))

// v1: exactly what the product runs, on cells that are whole verses.
const v1 = measure((sample) =>
  alignSourceBook(
    layerOf(trainKeys),
    trainKeys.map((key) => ({ cellId: key, refs: [key], text: textAll.get(key)!.text })),
    { onProgress: sample },
  ),
)
const v1ByCell = new Map(v1.value!.cells.map((cell) => [cell.cellId, cell]))
const v1Linker: Linker = (verse, _text) => {
  const key = verse.ids[0].slice(1, 9)
  const ids = new Map(verse.ids.map((id, k) => [id, k]))
  return (v1ByCell.get(key)?.links ?? []).map((link) => ({ src: ids.get(link.wordId)!, tgt: link.token, conf: link.conf }))
}
results.push(score("v1 D + names (source-alignment.ts, shipped)", v1Linker, v1))
report.candidates = results

if (args.compose) {
  // Bridge 2 trains on the cells a project has translated, which may be few:
  // score it at several sizes, each time on the verses it was trained on
  // (in book order, like a translation in progress).
  const finalFiles = clearFiles(args.data, args.compose, testament)
  const finalText = loadTargetText(finalFiles.tsv)
  const finalGold = loadGold(finalFiles.alignment, book)
  const keys = evalKeys.filter((key) => finalText.has(key))
  const composedRuns: unknown[] = []
  for (const size of [...new Set([25, 50, 120, 300, keys.length].filter((n) => n <= keys.length))]) {
    const trained = keys.slice(0, size)
    const bridge2 = trainWordAlignModel(trained.map((key) => ({ src: tokenize(textAll.get(key)!.text), tgt: tokenize(finalText.get(key)!.text) })))!
    const composedScorer = createScorer(finalGold, mentions)
    for (const key of trained) {
      const verse = greekAll.get(key)!
      const b1 = v1ByCell.get(key)?.links ?? []
      const b2 = alignWords(bridge2, tokenize(textAll.get(key)!.text), tokenize(finalText.get(key)!.text))
      const links: PredictedLink[] = composeBridges(b1, b2).map((link) => ({
        wordId: link.wordId,
        targetId: finalText.get(key)!.ids[link.token],
        conf: link.conf,
      }))
      composedScorer.add(verse.ids, verse.words, links)
    }
    const composed = {
      name: `Bridges 1+2: Greek → ${args.text} → ${args.compose}, Bridge 2 trained on ${size} verses`,
      scores: composedScorer.scores,
      precisionByConfidence: Object.fromEntries(
        CLASSES.map((c) => [c, precisionByConfidence(composedScorer.confidences[c], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6])]),
      ),
      solidBand: Object.fromEntries(CLASSES.map((c) => [c, bandPrecision(composedScorer.confidences[c], TINT_SOLID_MIN, 2)])),
      dottedBand: Object.fromEntries(CLASSES.map((c) => [c, bandPrecision(composedScorer.confidences[c], 0, TINT_SOLID_MIN)])),
    }
    composedRuns.push(composed)
    if (!args.json) {
      console.log(`\n== ${composed.name}`)
      for (const c of CLASSES) console.log(`  ${c.padEnd(13)} ${scoreRow(composedScorer.scores[c])}`)
      for (const c of ["pronoun", "mention"] as const) {
        const row = composed.precisionByConfidence[c].map((p) => `≥${p.min}: ${p.precision === null ? "-" : (100 * p.precision).toFixed(1)}`)
        console.log(`  precision by confidence, ${c.padEnd(12)} ${row.join("  ")}`)
      }
    }
  }
  // The design's choice for Bridge 2, completion/interlinear.ts, on the whole book, for comparison.
  const interlinearModel = buildAlignmentModel(keys.map((key) => ({ source: textAll.get(key)!.text, target: finalText.get(key)!.text })))
  const viaInterlinear = createScorer(finalGold, mentions)
  for (const key of keys) {
    const verse = greekAll.get(key)!
    const b2 = alignCell(textAll.get(key)!.text, finalText.get(key)!.text, interlinearModel).map((link) => ({
      src: link.srcIndex,
      tgt: link.tgtIndex,
      conf: link.confidence,
    }))
    viaInterlinear.add(
      verse.ids,
      verse.words,
      composeBridges(v1ByCell.get(key)?.links ?? [], b2).map((link) => ({
        wordId: link.wordId,
        targetId: finalText.get(key)!.ids[link.token],
        conf: link.conf,
      })),
    )
  }
  composedRuns.push({
    name: `Bridges 1+2 with Bridge 2 = interlinear.ts, ${keys.length} verses`,
    scores: viaInterlinear.scores,
    precisionByConfidence: Object.fromEntries(
      CLASSES.map((c) => [c, precisionByConfidence(viaInterlinear.confidences[c], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6])]),
    ),
  })
  if (!args.json) {
    console.log(`\n== Bridges 1+2 with Bridge 2 = interlinear.ts, ${keys.length} verses`)
    for (const c of CLASSES) console.log(`  ${c.padEnd(13)} ${scoreRow(viaInterlinear.scores[c])}`)
  }
  report.composed = composedRuns
}

if (args.sweep) {
  // Tune on another book, so the reported book's numbers are not tuned on it.
  const dev = args.sweep
  const devGreek = loadPackText(args.pack, [dev])
  const devGold = loadGold(files.alignment, dev)
  const devMentions = loadMentionKinds(args.pack, dev)
  const devKeys = [...devGreek.keys()].filter((key) => key.startsWith(bookNumber(dev)) && textAll.has(key)).sort()
  const devCounts = new Map<string, number>()
  for (const key of devKeys) for (const word of devGreek.get(key)!.words) devCounts.set(surface(word), (devCounts.get(surface(word)) ?? 0) + 1)
  const rows: { setting: string; mentionF: number; pronounSolidP: number; pronounHit: number }[] = []
  for (const surfaceMin of [1, 3, 5, 10, Infinity])
    for (const lambda of [2, 4, 6])
      for (const nullProb of [0.04, 0.08, 0.16])
        for (const iterations of [4, 6, 10]) {
          const tokensOf = (words: readonly BkpWord[]) =>
            words.map((word) => ((devCounts.get(surface(word)) ?? 0) >= surfaceMin ? surface(word) : `lemma:${lemma(word)}`))
          const model = trainWordAlignModel(
            devKeys.map((key) => ({ src: tokensOf(devGreek.get(key)!.words), tgt: tokenize(textAll.get(key)!.text) })),
            { lambda, nullProb, iterations },
          )!
          const scorer = createScorer(devGold, devMentions)
          for (const key of devKeys) {
            const verse = devGreek.get(key)!
            const text = textAll.get(key)!
            const links = alignWords(model, tokensOf(verse.words), tokenize(text.text))
            scorer.add(verse.ids, verse.words, links.map((link) => ({ wordId: verse.ids[link.src], targetId: text.ids[link.tgt], conf: link.conf })))
          }
          const m = scorer.scores.mention
          const p = m.correct / Math.max(1, m.predicted)
          const r = m.correct / Math.max(1, m.gold)
          const solid = precisionByConfidence(scorer.confidences.pronoun, [TINT_SOLID_MIN])[0].precision ?? 0
          rows.push({
            setting: `surfaceMin=${surfaceMin} lambda=${lambda} null=${nullProb} iterations=${iterations}`,
            mentionF: (2 * p * r) / Math.max(1e-9, p + r),
            pronounSolidP: solid,
            pronounHit: scorer.scores.pronoun.wordsHit / Math.max(1, scorer.scores.pronoun.words),
          })
        }
  rows.sort((a, b) => b.mentionF - a.mentionF)
  report.sweep = { dev, rows }
  if (!args.json) {
    console.log(`\n== sweep on ${dev} (${devKeys.length} verses), best 12 by mention F1`)
    for (const row of rows.slice(0, 12)) {
      console.log(
        `  F1 ${(100 * row.mentionF).toFixed(1)}  pronoun P@solid ${(100 * row.pronounSolidP).toFixed(1)}  pronoun hit ${(100 * row.pronounHit).toFixed(1)}  ${row.setting}`,
      )
    }
  }
}

if (args["write-fixture"]) {
  if (book !== "JHN" || args.text !== "BSB") throw new Error("--write-fixture writes the JHN 4 / BSB fixture only")
  const verses = evalKeys.filter((key) => key.startsWith("43004"))
  const fixture = {
    about: "JHN 4: pack Greek (text layer fields the aligner reads), BSB text, and Clear's manual SBLGNT→BSB links as BSB token indexes. See ATTRIBUTION.md.",
    verses: verses.map((key) => {
      const verse = greekAll.get(key)!
      const text = textAll.get(key)!
      return {
        ref: verse.ref,
        bsb: text.text,
        words: verse.ids.map((id, k) => {
          const word = verse.words[k]
          const goldTokens = [...(gold.get(id) ?? [])].flatMap((target) => text.ids.flatMap((tid, j) => (tid === target ? [j] : [])))
          return { id, text: word.text, lemma: word.lemma, class: word.class, type: word.type ?? null, gold: goldTokens }
        }),
      }
    }),
  }
  const out = path.resolve(import.meta.dirname, "..", "src", "lib", "bible-data", "__fixtures__", "bridge-jhn4.json")
  writeFileSync(out, JSON.stringify(fixture) + "\n")
  if (!args.json) console.log(`\nwrote ${out}`)
}

if (args.json) console.log(JSON.stringify(report, null, 2))
