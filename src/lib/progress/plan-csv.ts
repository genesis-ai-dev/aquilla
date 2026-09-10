// AQU-1093/1096: CSV of the project plan.
//
// Replaces the file-breakdown export, which listed files with cell counts. The
// plan is what a manager actually reports on, so the export carries the same
// columns the board shows: what each unit is, where it stands, when it is due
// and how far along it is.

import type { PlanUnit, PlanUnitStatus } from "@/lib/plan/plan-status"
import { planUnitLabel, planUnitStatus } from "@/lib/plan/plan-status"

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

/** Human-readable status, matching the board's own vocabulary. */
const STATUS_TEXT: Record<PlanUnitStatus, string> = {
  done: "Done",
  overdue: "Overdue",
  soon: "Due soon",
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
  const rows = units.map((u) => [
    planUnitLabel(u),
    STATUS_TEXT[planUnitStatus(u, now)],
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
