import { deadlineStatus, type PortfolioProject } from "@/lib/frontier/portfolio"

/** User-facing project health labels — single source of truth. */
export const PROJECT_STATUS_LABEL = {
  overdue: "Overdue",
  soon: "Due soon",
  stalled: "Stalled",
  onTrack: "On track",
  archived: "Archived",
} as const

export type ProjectAttentionKind = "overdue" | "soon" | "stalled"

export interface ProjectAttentionReason {
  kind: ProjectAttentionKind
  label: string
}

const STALE_MS = 14 * 24 * 60 * 60 * 1000

export type PortfolioActivityStatus = "not-started" | "stalled" | "active"

/**
 * A project with no translated cells hasn't stalled — it just hasn't started
 * yet. We key "not-started" on translation progress (`filledCells`), NOT on a
 * null `lastEditAt`: importing source text stamps `files.last_edit_at` (source
 * cells carry `last_edit_at` = import time), so an imported-but-untranslated
 * project has a non-null `lastEditAt` even though no translation work has
 * happened. Gating on `lastEditAt == null` mislabeled those projects "Stalled"
 * once the import aged past the stale window (AQU-639).
 */
export function portfolioActivityStatus(p: PortfolioProject, now: number): PortfolioActivityStatus {
  if (p.filledCells === 0) return "not-started"
  if (p.lastEditAt == null || now - p.lastEditAt > STALE_MS) return "stalled"
  return "active"
}

/** Why an org portfolio project needs attention (deadline + activity). */
export function portfolioAttentionReasons(p: PortfolioProject, now: number): ProjectAttentionReason[] {
  const reasons: ProjectAttentionReason[] = []
  const dl = deadlineStatus(p, now)
  if (dl === "overdue") reasons.push({ kind: "overdue", label: PROJECT_STATUS_LABEL.overdue })
  else if (dl === "soon") reasons.push({ kind: "soon", label: PROJECT_STATUS_LABEL.soon })
  if (portfolioActivityStatus(p, now) === "stalled") {
    reasons.push({ kind: "stalled", label: PROJECT_STATUS_LABEL.stalled })
  }
  return reasons
}
