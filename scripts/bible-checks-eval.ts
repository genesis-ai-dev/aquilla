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
 *     [--checks bkp:V1,bkp:V2,bkp:M1] [--samples 3]
 *
 * --text/--vref are an eBible-corpus pair: one verse per line, in the original
 * (ORG) versification the pack uses. The World English Bible (eng-engwebp) is
 * public domain. No data is checked in; the profile is English (“ ‘ “).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { compileFileExpectations } from "../db/shared/bible-checks/compile"
import { evaluateCell } from "../db/shared/bible-checks/evaluate"
import {
  BIBLE_CHECK_IDS,
  isBibleCheckId,
  type BibleCheckId,
  type StructureLayerInput,
  type VoicesLayerInput,
} from "../db/shared/bible-checks/types"
import type { LanguageProfile } from "../db/shared/language-profile"

const ENGLISH: LanguageProfile = {
  quoteMarks: {
    levels: [
      { open: "“", close: "”" },
      { open: "‘", close: "’" },
      { open: "“", close: "”" },
    ],
    continuation: "reopen-each-paragraph",
  },
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
const examples = new Map<BibleCheckId, string[]>(checks.map((id) => [id, []]))
let totalChecked = 0
const rows: string[][] = []

for (const [book, entry] of Object.entries(manifest.books)) {
  const verses = versesByBook.get(book)
  const voicesPath = join(packDir, "voices", `${book}.json`)
  if (!verses || !entry.layers.includes("voices") || !existsSync(voicesPath)) continue
  const voices = JSON.parse(readFileSync(voicesPath, "utf8")) as VoicesLayerInput
  const structurePath = join(packDir, "structure", `${book}.json`)
  const structure = existsSync(structurePath)
    ? (JSON.parse(readFileSync(structurePath, "utf8")) as StructureLayerInput)
    : null
  const expectations = compileFileExpectations(
    verses.map(({ ref }) => ({ id: ref, globalReferences: [ref] })),
    voices,
    structure,
  )
  const counts = new Map<BibleCheckId, number>(checks.map((id) => [id, 0]))
  let checked = 0
  for (const { ref, text } of verses) {
    const expectation = expectations.get(ref)
    if (!expectation) continue
    checked++
    for (const finding of evaluateCell(text, expectation, ENGLISH)) {
      if (!counts.has(finding.code)) continue
      counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1)
      const list = examples.get(finding.code) ?? []
      if (list.length < samples) list.push(`${ref} [${finding.reason}] ${text}`)
    }
  }
  totalChecked += checked
  for (const id of checks) totals.set(id, (totals.get(id) ?? 0) + (counts.get(id) ?? 0))
  rows.push([book, String(checked), ...checks.map((id) => String(counts.get(id) ?? 0))])
}

const rate = (n: number) => (totalChecked ? ((100 * n) / totalChecked).toFixed(1) : "0.0")
const header = ["book", "verses", ...checks]
const table = [header, ...rows, ["total", String(totalChecked), ...checks.map((id) => String(totals.get(id) ?? 0))]]
const widths = header.map((_, col) => Math.max(...table.map((row) => row[col].length)))
for (const row of table) console.log(row.map((cell, col) => cell.padStart(widths[col])).join("  "))
console.log(`flags per 100 verses: ${checks.map((id) => `${id} ${rate(totals.get(id) ?? 0)}`).join(", ")}`)
for (const id of checks) {
  for (const line of examples.get(id) ?? []) console.log(`${id}  ${line}`)
}
