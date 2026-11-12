// AQU-1392: CSV serialization of the volume-analysis report.
//
// Kept out of the component (same reasoning as `progress/progress-csv.ts`) so
// the row/column shape gets direct unit coverage without rendering React, and
// out of `report.ts` so the pure aggregation has no formatting concerns.
// The RFC-4180 escaping itself is imported, not re-derived — one escaping rule
// for every CSV the app emits.

import { CSV_EOL, toCsvLine } from "@/lib/progress/progress-csv"
import type { AnalysisReport } from "./report"

const BAND_HEADER = ["Band", "Segments", "Words", "% of words", "Rate", "Weighted words"] as const
const FILE_HEADER = ["File", "Segments", "Words", "New words", "Repetition words", "Internal 75-99% words"] as const

/** Human labels for the payable bands, as shown in the table and the export. */
export const BAND_LABELS: Record<string, string> = {
  new: "New",
  repetition: "Repetitions",
  internal_75_99: "Internal fuzzy 75–99%",
  tm_75_99: "TM fuzzy 75–99%",
  tm_100: "TM 100%",
  ice: "In-context exact (101%)",
  mt: "Machine translation",
}

export function bandLabel(band: string): string {
  return BAND_LABELS[band] ?? band
}

/**
 * Serialize a report: the band table, the weighted total, then a per-file
 * breakdown. The two tables are separated by a blank line so a spreadsheet
 * import keeps them as distinct blocks rather than mis-aligning columns.
 */
export function analysisReportToCsv(report: AnalysisReport): string {
  const lines: string[] = [
    toCsvLine(["Analysis", report.label]),
    toCsvLine(["Scope", report.scope]),
    "",
    toCsvLine(BAND_HEADER),
    ...report.bands.map((b) =>
      toCsvLine([bandLabel(b.band), b.segments, b.words, b.pctOfWords, b.rate, b.payableWords]),
    ),
    "",
    toCsvLine(["Total segments", report.totalSegments]),
    toCsvLine(["Total words", report.totalWords]),
    toCsvLine(["Weighted (payable) words", report.payableWords]),
    toCsvLine(["Saving on word count %", report.discountPct]),
  ]

  if (report.files.length > 1) {
    lines.push(
      "",
      toCsvLine(FILE_HEADER),
      ...report.files.map((f) =>
        toCsvLine([
          f.name,
          f.segments,
          f.words,
          f.wordsPerBand.new,
          f.wordsPerBand.repetition,
          f.wordsPerBand.internal_75_99,
        ]),
      ),
    )
  }

  return lines.join(CSV_EOL)
}

/**
 * Filesystem-safe download name. Mirrors `progressCsvFilename()` so downloads
 * from the two report surfaces look like siblings in the browser's list.
 */
export function analysisCsvFilename(label: string): string {
  const safe = label.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  return `${safe || "project"}-analysis.csv`
}
