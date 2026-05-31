#!/usr/bin/env tsx
// USFM conformance report — the artifact that answers a skeptical translation
// consultant's three questions, with data from their own corpus:
//
//   1. "Will you lose anything?"        → byte-exact round-trip, every file.
//   2. "Can I translate everything?"    → 0 orphaned translatable runs; a
//                                          breakdown of every translatable
//                                          role (verse, footnote text, Selah,
//                                          divine name, headings, …).
//   3. "Did you flatten my structure?"  → refs/numbers/markers counted
//                                          separately from translatable text.
//
// Run:  npx tsx scripts/usfm-conformance.ts [dir]
// Exit code: 0 iff every file round-trips, partitions, and has 0 orphans.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { analyzeCoverage, classifyRuns, type RunKind } from "../src/lib/parsers/usfm-tokenize"

const DEFAULT_DIR =
  "/Users/ryderwishart/Library/Mobile Documents/com~apple~CloudDocs/Frontier/Older documents"

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else if (e.isFile() && /\.(sfm|usfm)$/i.test(e.name)) out.push(full)
  }
  return out
}

const dir = process.argv[2] ?? DEFAULT_DIR
const files = walk(dir).sort()

let pass = 0
const failures: { file: string; why: string }[] = []
const totalBytes: Record<RunKind, number> = {
  marker: 0, translatable: 0, reference: 0, number: 0, whitespace: 0, metadata: 0,
}
const roleCounts = new Map<string, number>()
let totalTranslatableRuns = 0

for (const file of files) {
  const raw = readFileSync(file, "utf8")
  const rep = analyzeCoverage(raw)
  const problems: string[] = []
  if (!rep.roundTrips) problems.push("round-trip mismatch")
  if (!rep.partitions) problems.push("non-partition (gap/overlap)")
  if (rep.orphanedTranslatable.length > 0)
    problems.push(`${rep.orphanedTranslatable.length} orphaned translatable run(s)`)

  if (problems.length > 0) {
    failures.push({ file, why: problems.join("; ") })
    continue
  }
  pass++
  for (const k of Object.keys(totalBytes) as RunKind[]) totalBytes[k] += rep.bytesByKind[k]
  totalTranslatableRuns += rep.translatableRuns.length
  for (const r of classifyRuns(raw)) {
    if (r.kind === "translatable") roleCounts.set(r.role, (roleCounts.get(r.role) ?? 0) + 1)
  }
}

const grand = Object.values(totalBytes).reduce((a, b) => a + b, 0)
const pct = (n: number) => ((100 * n) / grand).toFixed(1) + "%"

console.log(`USFM conformance over ${files.length} files\n`)
console.log(`  round-trip + partition + 0-orphans:  ${pass}/${files.length}`)
console.log(`  translatable runs captured:          ${totalTranslatableRuns.toLocaleString()}`)
console.log("")
console.log("Byte budget (where every byte goes):")
for (const k of Object.keys(totalBytes) as RunKind[]) {
  console.log(`  ${k.padEnd(13)} ${totalBytes[k].toLocaleString().padStart(12)}  ${pct(totalBytes[k])}`)
}
console.log("")
console.log("Translatable runs by role (every localizable surface):")
for (const [role, n] of [...roleCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${role.padEnd(22)} ${n.toLocaleString().padStart(9)}`)
}
console.log("")

if (failures.length > 0) {
  console.log(`✗ ${failures.length} file(s) FAILED conformance:`)
  for (const f of failures.slice(0, 20)) console.log(`  ${f.file}\n    ${f.why}`)
  process.exit(1)
} else {
  console.log("✓ Every file round-trips byte-for-byte, partitions exactly, and has 0 orphaned translatable text.")
  process.exit(0)
}
