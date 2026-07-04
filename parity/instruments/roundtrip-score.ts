/**
 * I2 — roundtrip:score [--dev|--holdout]  (FROZEN after Phase 0, F7)
 *
 * Runs the frozen corpus runner under vitest (for the @/ alias + happy-dom
 * DOMParser the real parsers need), reads the JSON report, and prints:
 *   --dev      per-file failures + per-format rates (dev files may be inspected)
 *   --holdout  AGGREGATE ONLY — never file names, diffs, or contents (F2)
 */
import { spawnSync } from "node:child_process"
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..")
const set = process.argv.includes("--holdout") ? "holdout" : "dev"

const r = spawnSync(
  "pnpm",
  ["vitest", "run", "--config", "parity/vitest.config.ts", "parity/roundtrip/runner.test.ts"],
  { cwd: repoRoot, env: { ...process.env, CORPUS_SET: set }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
)
const reportPath = join(here, "..", "roundtrip", `.report-${set}.json`)
if (!existsSync(reportPath)) {
  console.error("runner did not produce a report; vitest output follows:")
  console.error(r.stdout?.slice(-4000))
  console.error(r.stderr?.slice(-4000))
  process.exit(1)
}
const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  set: string
  generatedAt: string
  total: number
  passed: number
  perFormat: Record<string, { pass: number; total: number }>
  files?: { file: string; format: string; pass: boolean; failures: { check: string; detail: string }[] }[]
  blindedFailureChecks?: string[]
}

const pct = (a: number, b: number): string => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`)
console.log(`\n═══ roundtrip:score — ${set} set (${report.generatedAt}) ═══`)
console.log(`overall structural fidelity: ${report.passed}/${report.total} = ${pct(report.passed, report.total)}\n`)
console.log("per-format pass rates:")
for (const [format, a] of Object.entries(report.perFormat).sort()) {
  const bar = a.pass === a.total ? "✓" : " "
  console.log(`  ${bar} ${format.padEnd(11)} ${String(a.pass).padStart(3)}/${String(a.total).padEnd(3)} ${pct(a.pass, a.total)}`)
}

if (set === "dev" && report.files) {
  const failing = report.files.filter((f) => !f.pass)
  if (failing.length > 0) {
    console.log(`\nfailing dev files (${failing.length}):`)
    for (const f of failing.slice(0, 60)) {
      console.log(`  ✗ ${f.file}: ${f.failures.map((x) => x.check).join(", ")}`)
      for (const x of f.failures.slice(0, 2)) {
        if (x.detail) console.log(`      ${x.detail.split("\n")[0].slice(0, 160)}`)
      }
    }
    if (failing.length > 60) console.log(`  … and ${failing.length - 60} more`)
  }
} else if (set === "holdout" && report.blindedFailureChecks) {
  // aggregate failure-check histogram only — no filenames, no contents (F2)
  const hist = new Map<string, number>()
  for (const c of report.blindedFailureChecks) hist.set(c, (hist.get(c) ?? 0) + 1)
  if (hist.size > 0) {
    console.log("\nfailure-check histogram (blinded):")
    for (const [c, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} ${c}`)
  }
}

// history for delta tracking
const histPath = join(here, "..", `roundtrip-history-${set}.json`)
const hist: { at: string; passed: number; total: number }[] = existsSync(histPath)
  ? (JSON.parse(readFileSync(histPath, "utf8")) as { at: string; passed: number; total: number }[])
  : []
const prev = hist[hist.length - 1]
if (prev) {
  const d = report.passed - prev.passed
  console.log(`\ndelta vs last run: ${d >= 0 ? "+" : ""}${d} files (${prev.passed}/${prev.total} → ${report.passed}/${report.total})`)
}
hist.push({ at: report.generatedAt, passed: report.passed, total: report.total })
writeFileSync(histPath, JSON.stringify(hist, null, 2))

const target = 98
const score = (100 * report.passed) / Math.max(1, report.total)
if (set === "holdout") {
  console.log(`\nexit bar: ≥${target}% holdout — ${score >= target ? "MET ✓" : `NOT MET (${score.toFixed(1)}%)`}`)
}
