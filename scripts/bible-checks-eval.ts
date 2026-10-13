/**
 * Bible data checks over a published translation: a first precision signal
 * (AQU-1688; design doc §10, "Precision on published text").
 *
 * Runs the shared evaluator (db/shared/bible-checks) verse by verse and prints
 * how many verses each check flags per book. Published text is mostly correct,
 * so most flags are likely false positives: a high rate says which check, and
 * which book, to sample and adjudicate first.
 *
 *   npx tsx scripts/bible-checks-eval.ts \
 *     --pack <bible-wiki>/content/bkp/v1 \
 *     --text <ebible>/corpus/eng-engwebp.txt --vref <ebible>/metadata/vref.txt \
 *     [--checks bkp:V1,bkp:V2,bkp:M1] [--samples 3] [--variants omit|bracket|footnote]
 *
 * --text/--vref are an eBible-corpus pair: one verse per line, in the original
 * (ORG) versification the pack uses. The World English Bible (eng-engwebp) is
 * public domain. No data is checked in; the profile is English (“ ‘ “).
 *
 * AQU-1697 adds pack A: N1, N2, M3, S3, S6 and S7 per verse, with English
 * negators and number words below, and the S8 scan (bkp:S8) over the corpus's
 * verses. S1 needs heading cells, which a verse-per-line corpus has none of.
 * Each check's reasons are counted apart, and --samples picks flags spread
 * evenly over the NT, not the first ones.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { compileFileExpectations } from "../db/shared/bible-checks/compile"
import { evaluateCell } from "../db/shared/bible-checks/evaluate"
import { scanVersification } from "../db/shared/bible-checks/scans"
import {
  BIBLE_CHECK_IDS,
  isBibleCheckId,
  type BibleCheckId,
  type StructureLayerInput,
  type TextLayerInput,
  type VoicesLayerInput,
} from "../db/shared/bible-checks/types"
import { ABSENT_VERSES } from "../db/shared/bible-checks/variants"
import { TEXTUAL_VARIANT_POLICIES, type LanguageProfile, type TextualVariantPolicy } from "../db/shared/language-profile"

const ENGLISH: LanguageProfile = {
  quoteMarks: {
    levels: [
      { open: "“", close: "”" },
      { open: "‘", close: "’" },
      { open: "“", close: "”" },
    ],
    continuation: "reopen-each-paragraph",
  },
  // AQU-1691: M1 has its own slot; English asks with "?" alone, so it is saved empty.
  questionMarkers: {},
  // AQU-1697: what an English translator would list. Contractions are listed
  // whole, since a negator matches as a whole word. "unless" (if not), "lest"
  // (that not), "without" and "nowhere" carry a Greek negation in English.
  negators: [
    "not", "no", "never", "nothing", "none", "nobody", "neither", "nor", "cannot", "nowhere",
    "without", "unless", "lest",
    "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "won't", "wouldn't",
    "can't", "couldn't", "shouldn't", "haven't", "hasn't", "hadn't", "mustn't",
  ],
  // The words a number is built from; "one hundred fifty-three" is 100 + 50 + 3.
  numberWords: Object.fromEntries(
    [
      "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
      "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
    ]
      .map((word, i): [string, string] => [String(i + 1), word])
      .concat(
        ["thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].map((word, i): [string, string] => [
          String((i + 3) * 10),
          word,
        ]),
        [["100", "hundred"], ["1000", "thousand"]],
      ),
  ),
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function required(name: string): string {
  const value = arg(name)
  if (!value) {
    console.error(`missing --${name}; see the header of scripts/bible-checks-eval.ts`)
    process.exit(2)
  }
  return value
}

const packDir = required("pack")
const textLines = readFileSync(required("text"), "utf8").split("\n")
const vrefLines = readFileSync(required("vref"), "utf8").split("\n")
const checks = (arg("checks") ?? "bkp:V1,bkp:V2,bkp:M1").split(",").filter(isBibleCheckId)
const samples = Number.parseInt(arg("samples") ?? "0", 10)
if (checks.length === 0) {
  console.error(`--checks must name some of ${BIBLE_CHECK_IDS.join(", ")}`)
  process.exit(2)
}
const variants = arg("variants") ?? "bracket"
if (!(TEXTUAL_VARIANT_POLICIES as readonly string[]).includes(variants)) {
  console.error(`--variants must be one of ${TEXTUAL_VARIANT_POLICIES.join(", ")}`)
  process.exit(2)
}
const profile: LanguageProfile = { ...ENGLISH, textualVariants: variants as TextualVariantPolicy }

const versesByBook = new Map<string, { ref: string; text: string }[]>()
vrefLines.forEach((ref, i) => {
  const text = (textLines[i] ?? "").trim()
  if (!ref || !text || text === "<range>") return
  const book = ref.split(" ")[0]
  const list = versesByBook.get(book) ?? []
  list.push({ ref, text })
  versesByBook.set(book, list)
})

const manifest = JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8")) as {
  books: Record<string, { layers: string[] }>
}
const totals = new Map<BibleCheckId, number>(checks.map((id) => [id, 0]))
const reasons = new Map<string, number>()
const flags = new Map<BibleCheckId, string[]>(checks.map((id) => [id, []]))
let totalChecked = 0
const rows: string[][] = []
const packHasAbsent: string[] = []

function readLayer<T>(layer: string, book: string): T | null {
  const path = join(packDir, layer, `${book}.json`)
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null
}

function count(id: BibleCheckId, reason: string, line: string): void {
  totals.set(id, (totals.get(id) ?? 0) + 1)
  reasons.set(`${id} ${reason}`, (reasons.get(`${id} ${reason}`) ?? 0) + 1)
  flags.get(id)?.push(line)
}

for (const [book, entry] of Object.entries(manifest.books)) {
  const verses = versesByBook.get(book)
  const voices = entry.layers.includes("voices") ? readLayer<VoicesLayerInput>("voices", book) : null
  if (!verses || !voices) continue
  const structure = readLayer<StructureLayerInput>("structure", book)
  const text = readLayer<TextLayerInput>("text", book)
  // AQU-1697: the S6 list against this pack's verse set (see db/shared/bible-checks/variants.ts).
  for (const ref of ABSENT_VERSES) if (ref.startsWith(`${book} `) && structure?.verses[ref]) packHasAbsent.push(ref)
  const cells = verses.map(({ ref }) => ({ id: ref, globalReferences: [ref] }))
  const expectations = compileFileExpectations(cells, voices, structure, text)
  const before = new Map(totals)
  let checked = 0
  for (const { ref, text: verseText } of verses) {
    const expectation = expectations.get(ref)
    if (!expectation) continue
    checked++
    for (const finding of evaluateCell(verseText, expectation, profile)) {
      if (!totals.has(finding.code)) continue
      const params = Object.entries(finding.params).map(([k, v]) => `${k}=${v}`).join(" ")
      count(finding.code, finding.reason, `${ref} [${finding.reason}${params ? ` ${params}` : ""}] ${verseText}`)
    }
  }
  if (totals.has("bkp:S8") && structure) {
    for (const finding of scanVersification(cells, structure)) {
      const refs = finding.evidence.kind === "versification" ? finding.evidence.refs.join(", ") : ""
      count("bkp:S8", finding.reason, `${finding.cellId} [${finding.reason}] ${refs}`)
    }
  }
  totalChecked += checked
  rows.push([book, String(checked), ...checks.map((id) => String((totals.get(id) ?? 0) - (before.get(id) ?? 0)))])
}

const rate = (n: number) => (totalChecked ? ((100 * n) / totalChecked).toFixed(1) : "0.0")
const header = ["book", "verses", ...checks]
const table = [header, ...rows, ["total", String(totalChecked), ...checks.map((id) => String(totals.get(id) ?? 0))]]
const widths = header.map((_, col) => Math.max(...table.map((row) => row[col].length)))
for (const row of table) console.log(row.map((cell, col) => cell.padStart(widths[col])).join("  "))
console.log(`flags per 100 verses: ${checks.map((id) => `${id} ${rate(totals.get(id) ?? 0)}`).join(", ")}`)
for (const [key, n] of [...reasons].sort()) console.log(`  ${key}: ${n} (${rate(n)} per 100 verses)`)
if (packHasAbsent.length > 0) console.log(`note: the pack has these S6 verses: ${packHasAbsent.join(", ")}`)
// Samples spread evenly over the run, so one book does not fill them.
for (const id of checks) {
  const all = flags.get(id) ?? []
  const step = all.length / Math.max(1, Math.min(samples, all.length))
  for (let i = 0; i < Math.min(samples, all.length); i++) console.log(`${id}  ${all[Math.floor(i * step)]}`)
}
