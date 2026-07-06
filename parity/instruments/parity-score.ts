/**
 * I1 — parity:score  (FROZEN after Phase 0, F7)
 *
 * Reads the frozen PARITY_MATRIX.yaml, runs the acceptance + EXCEEDS suites
 * under vitest (parity config for @/ alias + happy-dom), and prints per-row
 * pass/fail, the weighted total, and the delta vs the previous run.
 *
 * Row semantics (frozen):
 *   test.tag   → row passes iff ≥1 executed test title contains the tag AND
 *                every test carrying the tag passed. No matching test = FAIL.
 *   test.files → row passes iff every listed file exists and all its tests pass.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..")

interface Row {
  id: string
  capability: string
  evidence: string
  priority: "P0" | "P1" | "P2"
  weight: number
  acceptance: string
  test: { tag?: string; files?: string[] }
}
interface Matrix {
  meta: { frozen: boolean; frozenAt: string | null }
  rows: Row[]
  exceeds: (Omit<Row, "priority" | "weight" | "acceptance"> & { capability: string })[]
}

const matrix = parseYaml(readFileSync(join(repoRoot, "PARITY_MATRIX.yaml"), "utf8")) as Matrix
if (!matrix.meta.frozen) console.warn("!! matrix not marked frozen — Phase 0 incomplete")

// Collect files to run: all acceptance tests + every exceeds/files row file that exists.
const acceptanceDir = join(repoRoot, "parity", "acceptance")
mkdirSync(acceptanceDir, { recursive: true })
const acceptanceFiles = readdirSync(acceptanceDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join("parity", "acceptance", f))
const fileRows = [...matrix.rows, ...matrix.exceeds].filter((r) => r.test.files)
const rowFiles = [...new Set(fileRows.flatMap((r) => r.test.files ?? []))]
const existingRowFiles = rowFiles.filter((f) => existsSync(join(repoRoot, f)))
const toRun = [...acceptanceFiles, ...existingRowFiles]

interface AssertionResult {
  fullName: string
  status: string
}
interface JsonReport {
  testResults: { name: string; status: string; assertionResults: AssertionResult[] }[]
}

let report: JsonReport = { testResults: [] }
if (toRun.length > 0) {
  const outFile = join(here, "..", ".parity-vitest.json")
  spawnSync(
    "pnpm",
    [
      "vitest",
      "run",
      "--config",
      "parity/vitest.config.ts",
      "--reporter=json",
      `--outputFile=${outFile}`,
      ...toRun,
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
  if (existsSync(outFile)) report = JSON.parse(readFileSync(outFile, "utf8")) as JsonReport
}

const assertions: AssertionResult[] = report.testResults.flatMap((t) => t.assertionResults)
const fileStatus = new Map<string, boolean>()
for (const t of report.testResults) {
  // vitest JSON name is absolute; normalize to repo-relative
  const rel = t.name.startsWith(repoRoot) ? t.name.slice(repoRoot.length + 1) : t.name
  const allPassed = t.status === "passed" && t.assertionResults.every((a) => a.status === "passed")
  fileStatus.set(rel, allPassed)
}

const rowResult = (row: { test: { tag?: string; files?: string[] } }): { pass: boolean; why: string } => {
  if (row.test.tag) {
    const matching = assertions.filter((a) => a.fullName.includes(row.test.tag as string))
    if (matching.length === 0) return { pass: false, why: "no acceptance test yet" }
    const failing = matching.filter((a) => a.status !== "passed")
    return failing.length === 0
      ? { pass: true, why: `${matching.length} test(s)` }
      : { pass: false, why: `${failing.length}/${matching.length} failing: ${failing[0].fullName.slice(0, 90)}` }
  }
  const files = row.test.files ?? []
  for (const f of files) {
    if (!existsSync(join(repoRoot, f))) return { pass: false, why: `missing file ${f}` }
    if (!fileStatus.get(f)) return { pass: false, why: `failing file ${f}` }
  }
  return { pass: true, why: `${files.length} file(s)` }
}

let weightTotal = 0
let weightPass = 0
const counts = { P0: { pass: 0, total: 0 }, P1: { pass: 0, total: 0 }, P2: { pass: 0, total: 0 } }
console.log(`\n═══ parity:score — frozen ${matrix.meta.frozenAt ?? "(unfrozen)"} ═══\n`)
for (const row of matrix.rows) {
  const r = rowResult(row)
  weightTotal += row.weight
  if (r.pass) weightPass += row.weight
  counts[row.priority].total++
  if (r.pass) counts[row.priority].pass++
  console.log(`  ${r.pass ? "✓" : "✗"} [${row.priority}] ${row.id.padEnd(26)} ${r.pass ? "" : r.why}`)
}
console.log("\n  EXCEEDS (regression guards — must stay green):")
let exceedsAllGreen = true
for (const row of matrix.exceeds) {
  const r = rowResult(row)
  if (!r.pass) exceedsAllGreen = false
  console.log(`  ${r.pass ? "✓" : "✗"} [EX] ${row.id.padEnd(26)} ${r.pass ? "" : r.why}`)
}

const weighted = weightTotal === 0 ? 0 : (100 * weightPass) / weightTotal
console.log(`\n  P0: ${counts.P0.pass}/${counts.P0.total}   P1: ${counts.P1.pass}/${counts.P1.total}   P2: ${counts.P2.pass}/${counts.P2.total}   EXCEEDS green: ${exceedsAllGreen}`)
console.log(`  weighted score: ${weighted.toFixed(1)}%`)
console.log(
  `  exit bar: P0 100% ${counts.P0.pass === counts.P0.total ? "MET ✓" : "NOT MET"} | P1 ≥90% ${counts.P1.total > 0 && counts.P1.pass / counts.P1.total >= 0.9 ? "MET ✓" : "NOT MET"}`,
)

const histPath = join(here, "..", "score-history.json")
const hist: { at: string; weighted: number; p0: string; p1: string }[] = existsSync(histPath)
  ? (JSON.parse(readFileSync(histPath, "utf8")) as { at: string; weighted: number; p0: string; p1: string }[])
  : []
const prev = hist[hist.length - 1]
if (prev) console.log(`  delta vs last run: ${(weighted - prev.weighted).toFixed(1)} pts (was ${prev.weighted.toFixed(1)}%)`)
hist.push({
  at: new Date().toISOString(),
  weighted,
  p0: `${counts.P0.pass}/${counts.P0.total}`,
  p1: `${counts.P1.pass}/${counts.P1.total}`,
})
writeFileSync(histPath, JSON.stringify(hist, null, 2))
