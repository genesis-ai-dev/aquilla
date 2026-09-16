// AQU-1093/1096: CSV of the project plan.
//
// Replaces the file-breakdown export, which listed files with cell counts. The
// plan is what a manager actually reports on, so the export carries the same
// columns the board shows: what each unit is, where it stands, when it is due
// and how far along it is.

import type { PlanUnit, PlanUnitStatus } from "@/lib/plan/plan-status"
import { audioFileIds, planUnitLabel, planUnitStatus } from "@/lib/plan/plan-status"

const HEADER = [
  "Unit",
  "Status",
  "Target date",
  "Marked done",
  "Marked done by",
  "Translated %",
  "Validated %",
  "Audio recorded %",
  "Audio validated %",
  "Last activity",
] as const

/**
 * Human-readable status, worded exactly as the board's English group headings
 * are worded, so a manager who sorts this column recognises the groups they
 * were just looking at. Plain literals and not i18n keys on purpose: the export
 * is a file that gets mailed on and opened by someone who never saw the board,
 * and a spreadsheet column is filtered on its text.
 *
 * Exhaustive by type, and that is the safety net. A status added to the union
 * and forgotten here would export an empty Status cell on every row it applied
 * to — a silence nobody reads as a bug — so the compiler refuses the build
 * until the new status is named. That is how AQU-1278's `nearly_complete`
 * announced itself.
 */
const STATUS_TEXT: Record<PlanUnitStatus, string> = {
  done: "Done",
  overdue: "Overdue",
  soon: "Due soon",
  nearly_complete: "Nearly complete",
  in_progress: "In progress",
  not_started: "Not started",
}

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function pct(part: number, whole: number): string {
  return whole > 0 ? String(Math.round((part / whole) * 100)) : "0"
}

function isoDate(ms: number | null): string {
  return ms == null ? "" : new Date(ms).toISOString().slice(0, 10)
}

/** RFC 4180: CRLF line endings, quotes doubled inside quoted fields. */
export function planRowsToCsv(units: readonly PlanUnit[], now: number): string {
  // AQU-1278: whether audio is EXPECTED is decided per file across the whole
  // export, the same way the board decides it. Omitting this set makes
  // `planUnitStatus` fall back to the row's own `audioCount`, which is right
  // for a lone pill and wrong for a listing: an unrecorded book inside a file
  // whose other books are dubbed would then be judged on its text alone and
  // exported as Nearly complete, while the board — counting the recordings it
  // is missing — still calls it In progress. The two surfaces have to say the
  // same word about the same row, or the export is the one that gets believed.
  const audioFiles = audioFileIds(units)
  const rows = units.map((u) => [
    planUnitLabel(u),
    STATUS_TEXT[planUnitStatus(u, now, audioFiles)],
    u.targetDate ?? "",
    isoDate(u.doneAt),
    u.doneBy ?? "",
    pct(u.filledCount, u.totalCount),
    pct(u.validatedCount, u.totalCount),
    pct(u.audioCount, u.totalCount),
    pct(u.audioValidatedCount, u.totalCount),
    isoDate(u.lastEditAt),
  ])
  return [HEADER, ...rows].map((row) => row.map((c) => escapeCell(String(c))).join(",")).join("\r\n")
}

export function planCsvFilename(projectName: string): string {
  const safe = projectName.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "project"
  return `${safe}-plan.csv`
}
