#!/usr/bin/env tsx
// Round-trip identity test: parse → re-serialize → sha256 compare, across
// every .sfm / .usfm file under a directory. Defaults to the user's iCloud
// fixtures directory. Pass a different directory as argv[2] to override.
//
// Run:  npx tsx scripts/usfm-roundtrip.ts [dir]
//
// Exit code: 0 if all files round-trip identically, 1 otherwise.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  parseUsfmLossless,
  serializeUsfmLossless,
  type UsfmDocument,
} from "../src/lib/parsers/usfm-lossless"

// Count line-start `\v N` occurrences — the "ground truth" verse count.
// Same line-start anchoring as the parser, so it tolerates BOM and CRLF.
function countVerseLines(raw: string): number {
  const RE = /(?:^﻿?|\n)\\v[ \t]+\S+/g
  let n = 0
  while (RE.exec(raw) !== null) n++
  return n
}

// A verse text span is broken if it contains a verse-TERMINATING marker —
// something like \v, \c, \s, \mt — at line start. Paragraph/poetry/inline
// markers (\p, \q1-4, \wj, \nd, footnotes, etc.) are LEGITIMATELY inside
// verses per USFM semantics and don't count as leaks.
const STRUCTURAL_RE = /(?:^|\n)\\([a-z]+\d*)/g
const TERMINATES_VERSE = new Set([
  "v",
  "c", "cl", "cd", "cp", "cat",
  "s", "s1", "s2", "s3", "s4", "s5",
  "ms", "ms1", "ms2", "ms3", "ms4",
  "sr", "mr", "r",
  "sd", "sd1", "sd2", "sd3", "sd4",
  "sp",
  "d",
  "id", "ide", "rem",
  "h", "h1", "h2", "h3",
  "toc1", "toc2", "toc3", "toca1", "toca2", "toca3",
  "mt", "mt1", "mt2", "mt3", "mt4",
  "mte", "mte1", "mte2",
  "imt", "imt1", "imt2", "imt3",
  "imte", "imte1", "imte2",
  "is", "is1", "is2", "is3", "is4",
  "ip", "ipi", "ipr", "ipq",
  "im", "imi", "imq",
  "iq", "iq1", "iq2", "iq3",
  "ib", "ie",
  "ili", "ili1", "ili2",
  "io", "io1", "io2", "io3", "io4",
  "iot", "iex",
])

function spanLeaks(doc: UsfmDocument): { ref: string; leaked: string }[] {
  const leaks: { ref: string; leaked: string }[] = []
  for (const v of doc.verses) {
    STRUCTURAL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = STRUCTURAL_RE.exec(v.text)) !== null) {
      if (TERMINATES_VERSE.has(m[1])) {
        leaks.push({ ref: v.ref, leaked: `\\${m[1]}` })
        break
      }
    }
  }
  return leaks
}

// Mutation round-trip: replace every verse with a unique sentinel, serialize,
// re-parse, and confirm each ref now reads back as its sentinel. Catches:
//  - wrong textStart/textEnd (sentinel won't end up in the right verse)
//  - missing or duplicate verses (sentinel count mismatch)
//  - parser losing verses after re-parse
function mutationRoundtrip(doc: UsfmDocument): string | null {
  // Sentinel starts with non-whitespace and ends with a newline so re-parsing
  // recovers it exactly. Some real .SFM files have duplicate verse refs
  // (data-quality issue — e.g. two `\v 34` in a row); override map is keyed
  // by ref, so duplicates share the same override (last-write-wins). The
  // assertion below mirrors that.
  const overrides = new Map<string, string>()
  doc.verses.forEach((v, i) => {
    overrides.set(v.ref, `⟦SENTINEL_${i}⟧\n`)
  })
  const mutated = serializeUsfmLossless(doc, overrides)
  const reparsed = parseUsfmLossless(mutated)
  if (reparsed.verses.length !== doc.verses.length) {
    return `reparse verse count ${reparsed.verses.length} ≠ original ${doc.verses.length}`
  }
  for (let i = 0; i < doc.verses.length; i++) {
    const ref = doc.verses[i].ref
    if (reparsed.verses[i].ref !== ref) {
      return `verse ${i} ref ${reparsed.verses[i].ref} ≠ original ${ref}`
    }
    const expected = overrides.get(ref)!
    if (reparsed.verses[i].text !== expected) {
      return `verse ${ref} (idx ${i}) reparsed text ${JSON.stringify(reparsed.verses[i].text.slice(0, 60))} ≠ ${JSON.stringify(expected.slice(0, 60))}`
    }
  }
  return null
}

function duplicateRefs(doc: UsfmDocument): string[] {
  const seen = new Map<string, number>()
  const dups: string[] = []
  for (const v of doc.verses) {
    const n = (seen.get(v.ref) ?? 0) + 1
    seen.set(v.ref, n)
    if (n === 2) dups.push(v.ref)
  }
  return dups
}

const DEFAULT_DIR =
  "/Users/ryderwishart/Library/Mobile Documents/com~apple~CloudDocs/Frontier/Older documents"

function walk(dir: string): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    console.error(`Cannot read ${dir}: ${(e as Error).message}`)
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && /\.(sfm|usfm)$/i.test(entry.name)) out.push(full)
  }
  return out
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

function firstDiffIndex(a: string, b: string): number {
  const lim = Math.min(a.length, b.length)
  let i = 0
  while (i < lim && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function ctx(s: string, i: number, span = 40): string {
  const lo = Math.max(0, i - span)
  const hi = Math.min(s.length, i + span)
  return JSON.stringify(s.slice(lo, hi))
}

const dir = process.argv[2] ?? DEFAULT_DIR
const files = walk(dir).sort()
console.log(`Scanning ${files.length} files under ${dir}\n`)

let pass = 0
let fail = 0
const failures: { file: string; reason: string }[] = []
let totalVerses = 0
const filesWithDuplicates: { file: string; refs: string[] }[] = []

for (const file of files) {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (e) {
    fail++
    failures.push({ file, reason: `read error: ${(e as Error).message}` })
    continue
  }

  let parsed
  try {
    parsed = parseUsfmLossless(raw)
  } catch (e) {
    fail++
    failures.push({ file, reason: `parse error: ${(e as Error).message}` })
    continue
  }

  let serialized: string
  try {
    serialized = serializeUsfmLossless(parsed)
  } catch (e) {
    fail++
    failures.push({ file, reason: `serialize error: ${(e as Error).message}` })
    continue
  }

  // Check 1: identity round-trip with no overrides
  if (sha256(raw) !== sha256(serialized)) {
    fail++
    const i = firstDiffIndex(raw, serialized)
    failures.push({
      file,
      reason:
        `identity round-trip mismatch (lens ${raw.length} vs ${serialized.length}); ` +
        `first diff at byte ${i}:\n` +
        `      orig: ${ctx(raw, i)}\n` +
        `      new:  ${ctx(serialized, i)}`,
    })
    continue
  }

  // Check 2: verse count matches ground truth
  const groundTruth = countVerseLines(raw)
  if (parsed.verses.length !== groundTruth) {
    fail++
    failures.push({
      file,
      reason: `verse count: parser=${parsed.verses.length} vs raw \\v lines=${groundTruth}`,
    })
    continue
  }

  // Check 3: no verse-text span leaks past a structural marker
  const leaks = spanLeaks(parsed)
  if (leaks.length > 0) {
    fail++
    failures.push({
      file,
      reason: `${leaks.length} verse(s) leak across structural markers; first: ${leaks[0].ref} contains line-start ${leaks[0].leaked}`,
    })
    continue
  }

  // Check 4: mutation round-trip survives re-parse
  const mutationErr = mutationRoundtrip(parsed)
  if (mutationErr) {
    fail++
    failures.push({ file, reason: `mutation round-trip: ${mutationErr}` })
    continue
  }

  pass++
  totalVerses += parsed.verses.length
  const dups = duplicateRefs(parsed)
  if (dups.length > 0) filesWithDuplicates.push({ file, refs: dups })
}

console.log(`Pass: ${pass}/${files.length}  (verses validated: ${totalVerses})`)
console.log(`Fail: ${fail}/${files.length}\n`)

if (filesWithDuplicates.length > 0) {
  console.log(`Files with duplicate verse refs (round-trip OK, but flag for the user): ${filesWithDuplicates.length}`)
  for (const f of filesWithDuplicates.slice(0, 10)) {
    console.log(`  ${f.file}: ${f.refs.slice(0, 5).join(", ")}${f.refs.length > 5 ? ` (+${f.refs.length - 5} more)` : ""}`)
  }
  console.log("")
}

if (failures.length > 0) {
  const show = Math.min(failures.length, 30)
  console.log(`Failures (showing ${show}/${failures.length}):\n`)
  for (const f of failures.slice(0, show)) {
    console.log(`  ${f.file}`)
    console.log(`    ${f.reason}\n`)
  }
}

process.exit(fail > 0 ? 1 : 0)
