/**
 * FROZEN (F7) — round-trip scorer runner. Executes the fidelity checks over
 * the corpus set named by CORPUS_SET (dev | holdout) and writes a JSON report
 * for the roundtrip:score CLI. Do not modify after Phase 0.
 *
 * HOLDOUT BLINDING (F2): for the holdout set this runner records aggregates
 * only — per-file entries carry an opaque index, no filename, no contents,
 * no diffs, and failure details are stripped to the check name.
 */
import { describe, it } from "vitest"
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildAdapters } from "./adapters"
import {
  FORMAT_SPECS,
  type CheckFailure,
  validateXliff12,
  validateXliff20,
  validateTmx,
  validateHtml,
  validateOoxml,
  validateJsonEqual,
  multisetEqual,
  extractTimecodesMs,
} from "./checks"

const here = dirname(fileURLToPath(import.meta.url))
const corpusDir = join(here, "..", "corpus")

interface FileResult {
  file: string // dev: relative path; holdout: opaque "holdout-<n>"
  format: string
  pass: boolean
  failures: { check: string; detail: string }[]
}

describe("roundtrip fidelity", () => {
  it("scores the corpus set", { timeout: 600_000 }, async () => {
    const set = (process.env.CORPUS_SET === "holdout" ? "holdout" : "dev") as "dev" | "holdout"
    const split = JSON.parse(readFileSync(join(corpusDir, "split.json"), "utf8")) as {
      dev: string[]
      holdout: string[]
    }
    const files = split[set]
    const adapters = await buildAdapters()
    const dec = new TextDecoder()
    const results: FileResult[] = []

    for (let i = 0; i < files.length; i++) {
      const rel = files[i]
      const format = rel.split("/")[0]
      const spec = FORMAT_SPECS[format]
      const label = set === "holdout" ? `holdout-${i}` : rel
      const failures: CheckFailure[] = []
      const record = (): void => {
        results.push({
          file: label,
          format,
          pass: failures.length === 0,
          failures:
            set === "holdout"
              ? failures.map((f) => ({ check: f.check, detail: "" })) // blinded
              : failures.map((f) => ({ check: f.check, detail: f.detail.slice(0, 500) })),
        })
      }

      const adapter = adapters[format]
      if (!spec) {
        failures.push({ check: "spec", detail: "no FORMAT_SPECS entry" })
        record()
        continue
      }
      if (!adapter) {
        failures.push({ check: "no-adapter", detail: "format has no parser adapter yet" })
        record()
        continue
      }

      const bytes = new Uint8Array(readFileSync(join(corpusDir, "files", rel)))
      let segments: { source: string; target: string }[] = []
      try {
        segments = await adapter.parse(bytes, rel)
      } catch (e) {
        failures.push({ check: "parse-throws", detail: String(e) })
        record()
        continue
      }
      if (segments.length === 0) {
        failures.push({ check: "parse-empty", detail: "0 segments extracted" })
        record()
        continue
      }
      if (spec.kind === "import-only") {
        record()
        continue
      }
      if (!adapter.export) {
        failures.push({ check: "no-exporter", detail: "format has no exporter yet" })
        record()
        continue
      }

      let out: Uint8Array
      try {
        out = await adapter.export(bytes, rel)
      } catch (e) {
        failures.push({ check: "export-throws", detail: String(e) })
        record()
        continue
      }

      // family-specific external validation
      let v: CheckFailure | null = null
      if (spec.family === "xliff12") v = validateXliff12(out)
      else if (spec.family === "xliff20") v = validateXliff20(out)
      else if (spec.family === "tmx") v = validateTmx(out)
      else if (spec.family === "html") v = validateHtml(out)
      else if (spec.family === "ooxml-docx") v = validateOoxml(bytes, out, "docx")
      else if (spec.family === "ooxml-pptx") v = validateOoxml(bytes, out, "pptx")
      else if (spec.family === "json") v = validateJsonEqual(bytes, out)
      if (v) failures.push(v)

      if (spec.family === "subtitle") {
        const tOrig = extractTimecodesMs(dec.decode(bytes))
        const tOut = extractTimecodesMs(dec.decode(out))
        if (tOrig.length !== tOut.length || tOrig.some((ms, k) => ms !== tOut[k])) {
          failures.push({
            check: "timecodes",
            detail: `timecode multiset changed (${tOrig.length} vs ${tOut.length})`,
          })
        }
      }

      // import symmetry: re-parse the export; source text must survive
      try {
        const reparsed = await adapter.parse(out, rel)
        const eq = multisetEqual(
          segments.map((s) => s.source),
          reparsed.map((s) => s.source),
        )
        if (!eq.ok) failures.push({ check: "reparse-sources", detail: eq.detail })
        if (reparsed.length !== segments.length) {
          failures.push({
            check: "reparse-count",
            detail: `${segments.length} segments in, ${reparsed.length} after roundtrip`,
          })
        }
      } catch (e) {
        failures.push({ check: "reparse-throws", detail: String(e) })
      }
      record()
    }

    const byFormat = new Map<string, { pass: number; total: number }>()
    for (const r of results) {
      const agg = byFormat.get(r.format) ?? { pass: 0, total: 0 }
      agg.total++
      if (r.pass) agg.pass++
      byFormat.set(r.format, agg)
    }
    const report = {
      set,
      generatedAt: new Date().toISOString(),
      total: results.length,
      passed: results.filter((r) => r.pass).length,
      perFormat: Object.fromEntries(
        [...byFormat.entries()].map(([f, a]) => [f, { pass: a.pass, total: a.total }]),
      ),
      files: set === "holdout" ? undefined : results,
      // holdout: per-file detail limited to blinded check names for debugging trends
      blindedFailureChecks:
        set === "holdout"
          ? results.filter((r) => !r.pass).flatMap((r) => r.failures.map((f) => `${r.format}:${f.check}`))
          : undefined,
    }
    writeFileSync(join(here, `.report-${set}.json`), JSON.stringify(report, null, 2))
    // The runner never fails: the score is the CLI's business, not vitest's.
  })
})
