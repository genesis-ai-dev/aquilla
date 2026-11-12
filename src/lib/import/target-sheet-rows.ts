// A spreadsheet's data rows as rows for the file-scoped target import
// (lib/import-file-target): the translation, and whatever the mapping says can
// steer the match — a reference, the source text (AQU-1375), or start and end
// timestamps (AQU-1375), which put a subtitle spreadsheet through the same
// timing matcher as a subtitle file.

import { parseTimestamp, type ColumnMapping } from "@/lib/parsers/spreadsheet"
import { formatVttTime } from "@/lib/video/vtt-generator"
import type { TargetRow } from "@/lib/import-file-target"

export interface TargetSheetRows {
  rows: TargetRow[]
  /** Start and end columns are both mapped. */
  timed: boolean
}

/** A timestamp cell in seconds. A decimal comma (`00:00:01,500`, as SRT
 *  writes it) reads as a decimal point; anything else unreadable is undefined. */
function secondsIn(value: string | undefined): number | undefined {
  return parseTimestamp((value ?? "").trim().replace(/,(\d+)$/, ".$1"))
}

/** Every data row keeps its place, empty or not — order matching needs each
 *  row to hold its slot. A timed row with no reference of its own is labelled
 *  by its timecode, the way a subtitle file's cue is. */
export function targetSheetRows(dataRows: string[][], mapping: ColumnMapping): TargetSheetRows {
  const timed = mapping.startCol !== null && mapping.endCol !== null
  const rows = dataRows.map((r): TargetRow => {
    const ref = mapping.labelCol !== null ? (r[mapping.labelCol] ?? "").trim() || undefined : undefined
    const start = timed ? secondsIn(r[mapping.startCol!]) : undefined
    const end = timed ? secondsIn(r[mapping.endCol!]) : undefined
    const timing = start !== undefined && end !== undefined
      ? { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) }
      : null
    return {
      ref: ref ?? (timing ? `${formatVttTime(start!)} --> ${formatVttTime(end!)}` : undefined),
      text: mapping.targetCol !== null ? (r[mapping.targetCol] ?? "").trim() : "",
      ...(mapping.sourceCol !== null ? { source: (r[mapping.sourceCol] ?? "").trim() } : {}),
      ...(timing ?? {}),
    }
  })
  return { rows, timed }
}
