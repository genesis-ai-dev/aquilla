#!/usr/bin/env tsx
/**
 * Writes the AQU-1278 fixture out as importable USFM — a source pack and a
 * target pack, from the same table the seeder uses.
 *
 *   ./node_modules/.bin/tsx scripts/write-plan-fixture-usfm.ts [outDir]
 *
 * Default outDir is ~/Downloads/aqu-1278-testing.
 *
 * WHAT AN IMPORT CAN AND CANNOT GIVE YOU. Importing these files into a fresh
 * project reproduces the cells, the chapter shapes, the headings, the missing
 * Genesis chapter and the untranslated gaps — which is enough to see the grid,
 * the gap, the extras row and the structural-cell policy. It CANNOT give you
 * validation state, recordings, assignments, target dates or Done marks:
 * nothing in a USFM file says who validated a verse. For those, run
 * `scripts/seed-plan-fixture.ts`, which builds the whole project directly.
 *
 * One honest divergence: Titus is seeded with canonical refs that carry no
 * chapter ("TIT:1"), the shape a one-chapter book takes when its section key
 * and its book code are the same string. USFM cannot express that — every
 * verse lives under a \c — so the imported Titus gets an ordinary chapter 1.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { ALL_BOOKS, cellsFor, isStructural, type Book } from "../src/lib/plan/plan-fixture"

/** Presentation only — the \h and \mt1 lines a human reads in the editor. */
const NAMES: Record<string, string> = {
  GEN: "Genesis", EXO: "Exodus", LEV: "Leviticus", NUM: "Numbers",
  DEU: "Deuteronomy", JOS: "Joshua", RUT: "Ruth", JON: "Jonah",
  OBA: "Obadiah", MRK: "Mark", LUK: "Luke", ACT: "Acts",
  TIT: "Titus", PHM: "Philemon",
}

/** Canonical order, so the filenames sort the way a Bible does. */
const ORDER = ["GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "RUT", "OBA", "JON",
  "MRK", "LUK", "ACT", "TIT", "PHM"]

interface Verse { chapter: number; verse: number; heading: boolean; frontMatter: boolean }

/** Pull the chapter and verse back out of a fixture cell's canonical ref. */
function locate(ref: string, code: string): Verse | null {
  if (ref === code) return { chapter: 0, verse: 0, heading: false, frontMatter: true }
  // Importer-shaped front matter — "GEN:mt1:1", book code : marker : line.
  // The fixture moved to this shape when it started placing front matter
  // where a real import does; matching only the bare code silently dropped
  // every front-matter line from the written packs.
  const parts = ref.split(":")
  if (parts.length === 3 && parts[0] === code && !/^\d+$/.test(parts[1])) {
    return { chapter: 0, verse: 0, heading: false, frontMatter: true }
  }
  const [left, right] = ref.split(":")
  const verse = Number(right)
  const chapter = left === code ? 1 : Number(left.slice(code.length + 1))
  if (!Number.isFinite(chapter) || !Number.isFinite(verse)) return null
  return { chapter, verse, heading: verse === 0, frontMatter: false }
}

function usfmFor(b: Book, side: "source" | "target"): string {
  const name = NAMES[b.code] ?? b.code
  const lines: string[] = [`\\id ${b.code} AQU-1278 plan board fixture`, `\\h ${name}`]

  const cells = cellsFor(b)
  const front = cells.filter((c) => locate(c.ref, b.code)?.frontMatter)
  if (front.length > 0) {
    lines.push(`\\mt1 ${side === "source" ? name : `Das Buch ${name}`}`)
    for (const [i, c] of front.entries()) {
      if (side === "target" && c.target === "") continue
      lines.push(
        `\\ip ${side === "source" ? `Introduction to ${name}, paragraph ${i + 1}.` : c.target}`,
      )
    }
  }

  let chapter = 0
  for (const c of cells) {
    const at = locate(c.ref, b.code)
    if (!at || at.frontMatter) continue
    if (at.chapter !== chapter) {
      chapter = at.chapter
      // Genesis has no chapter 7. The gap is deliberate: the grid must render
      // an empty cell there rather than shifting every later chapter left.
      lines.push(`\\c ${chapter}`)
    }
    if (at.heading) {
      // \s is a section heading — a STRUCTURAL cell under AQU-1083, and the
      // thing the "count structural cells" policy adds to or subtracts from
      // every total on the board.
      lines.push(`\\s ${side === "source" ? `Section ${chapter}` : c.target}`)
      lines.push("\\p")
      continue
    }
    if (side === "target") {
      // An untranslated cell is an ABSENT verse, not an empty one: that is how
      // a real partial translation arrives, and it is what leaves the plan
      // board with something to count.
      if (c.target === "") continue
      lines.push(`\\v ${at.verse} ${c.target}`)
    } else {
      lines.push(`\\v ${at.verse} ${name} ${chapter}:${at.verse} — source text.`)
    }
  }
  return lines.join("\n") + "\n"
}

function main(): void {
  const outDir = process.argv[2] ?? join(homedir(), "Downloads", "aqu-1278-testing")
  rmSync(join(outDir, "source"), { recursive: true, force: true })
  rmSync(join(outDir, "target"), { recursive: true, force: true })
  mkdirSync(join(outDir, "source"), { recursive: true })
  mkdirSync(join(outDir, "target"), { recursive: true })

  const rows: string[] = []
  for (const [i, code] of ORDER.entries()) {
    const b = ALL_BOOKS.find((x) => x.code === code)
    if (!b) throw new Error(`ORDER names a book the fixture does not have: ${code}`)
    const file = `${String(i + 1).padStart(2, "0")}-${code}.usfm`
    writeFileSync(join(outDir, "source", file), usfmFor(b, "source"), "utf8")
    writeFileSync(join(outDir, "target", file), usfmFor(b, "target"), "utf8")
    const cells = cellsFor(b)
    const content = cells.filter((c) => !isStructural(c.type))
    rows.push(
      `| ${code} | ${NAMES[code]} | ${b.chapters} | ${content.length} | ` +
      `${content.filter((c) => c.target === "").length} | ${b.expect.replace("_", " ")} |`,
    )
  }

  writeFileSync(join(outDir, "README.md"), README(rows), "utf8")
  console.log(`\nWrote ${ORDER.length} source and ${ORDER.length} target USFM files to`)
  console.log(`  ${outDir}\n`)
}

function README(rows: string[]): string {
  return `# AQU-1278 plan board — test files

Two packs of USFM, generated from \`src/lib/plan/plan-fixture.ts\`. Import
\`source/\` as the project's source and \`target/\` as its target translation.

| Book | Name | Chapters | Cells | Untranslated | Group it should land in |
|---|---|---|---|---|---|
${rows.join("\n")}

## What an import gives you, and what it does not

Importing both packs reproduces the cells, the chapter shapes, the section
headings, Genesis's missing chapter 7 and the untranslated gaps. That is enough
to see the chapter grid, the gap, the extras row and the structural-cell policy.

It does **not** give you validation state, recordings, assignments, target dates
or Done marks. Nothing in a USFM file says who validated a verse, so a freshly
imported project has every book at zero validated and lands almost entirely in
one group. The groups in the table above assume the validation state the seeder
writes.

For the full fixture, run the seeder instead. It builds the project directly in
the database, including all of the above:

\`\`\`
AQUILLA_DATABASE_URL=postgresql://aquilla@localhost/aquilla_dev \\
  ./node_modules/.bin/tsx scripts/seed-plan-fixture.ts
\`\`\`

It is idempotent — re-run it after clicking around and it rebuilds exactly this
fixture. Target dates are computed from the run date, so re-running also
refreshes "overdue" and "due soon".

## One divergence

Titus is seeded with canonical refs that carry no chapter (\`TIT:1\`), the shape
a one-chapter book takes when its section key and its book code are the same
string. USFM cannot express that — every verse lives under a \`\\c\` — so the
imported Titus gets an ordinary chapter 1 and stops testing that case.
`
}

main()
