#!/usr/bin/env tsx
// Marker-coverage gap detection.
//
// Extracts every backslash marker from every .SFM file under a directory,
// normalizes + classifies each against the taxonomy, and reports any marker
// the taxonomy DOESN'T know. A skeptical consultant's first question is "what
// did you miss?" — this answers it with data from their own corpus.
//
// Run:  npx tsx scripts/usfm-marker-coverage.ts [dir]
// Exit code: 0 if every marker is classified, 1 if any are unknown.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  classifyMarker,
  normalizeMarker,
  type MarkerCategory,
} from "../src/lib/parsers/usfm-markers"

const DEFAULT_DIR =
  "/Users/ryderwishart/Library/Mobile Documents/com~apple~CloudDocs/Frontier/Older documents"

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && /\.(sfm|usfm)$/i.test(entry.name)) out.push(full)
  }
  return out
}

// Matches \marker, \+marker (nested), and \marker* (end), with optional digits.
const MARKER_RE = /\\\+?[a-z]+\d*\*?/g

const dir = process.argv[2] ?? DEFAULT_DIR
const files = walk(dir).sort()

const rawCounts = new Map<string, number>()
const unknownExamples = new Map<string, string>() // base → file where seen
const byCategory = new Map<MarkerCategory, Set<string>>()
let translatableBases = 0

for (const file of files) {
  const text = readFileSync(file, "utf8")
  const matches = text.match(MARKER_RE)
  if (!matches) continue
  for (const raw of matches) {
    rawCounts.set(raw, (rawCounts.get(raw) ?? 0) + 1)
  }
}

const distinctRaw = [...rawCounts.keys()].sort()
const unknownRaw: string[] = []
const knownBases = new Set<string>()

for (const raw of distinctRaw) {
  const spec = classifyMarker(raw)
  if (!spec) {
    unknownRaw.push(raw)
    if (!unknownExamples.has(normalizeMarker(raw))) unknownExamples.set(normalizeMarker(raw), raw)
    continue
  }
  const base = normalizeMarker(raw)
  if (!knownBases.has(base)) {
    knownBases.add(base)
    if (spec.translatable) translatableBases++
    if (!byCategory.has(spec.category)) byCategory.set(spec.category, new Set())
  }
  byCategory.get(spec.category)!.add(base)
}

console.log(`Files: ${files.length}`)
console.log(`Distinct raw marker tokens: ${distinctRaw.length}`)
console.log(`Distinct base markers (classified): ${knownBases.size}`)
console.log(`  of which translatable: ${translatableBases}`)
console.log("")
console.log("By category:")
for (const [cat, set] of [...byCategory.entries()].sort()) {
  console.log(`  ${cat.padEnd(16)} ${[...set].sort().join(", ")}`)
}
console.log("")

if (unknownRaw.length > 0) {
  console.log(`⚠ UNKNOWN markers (not in taxonomy): ${unknownRaw.length}`)
  for (const raw of unknownRaw) {
    console.log(`  ${raw}  (×${rawCounts.get(raw)}, normalizes to "${normalizeMarker(raw)}")`)
  }
  process.exit(1)
} else {
  console.log("✓ Every marker in the corpus is classified by the taxonomy.")
  process.exit(0)
}
