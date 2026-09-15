// AQU-1096: how a reader has chosen to LOOK at the plan.
//
// Both preferences here are per-user, client-side only (localStorage). Neither
// touches project data, neither syncs, and neither is visible to anyone else —
// same standing as the Progress card's hidden-stat set, whose shape this file
// copies deliberately (`src/lib/metrics/hidden-stats.ts`): every read and write
// wrapped, a bad stored value dropped rather than thrown, so storage that has
// gone bad in a private window can never blank the board.
//
// WHY THE TWO ARE SCOPED DIFFERENTLY, which is the only interesting decision:
//
//  · The VIEW MODE is global. Grouping by status or reading in order is a
//    working style — how this person likes to look at a plan — and it should
//    not reset every time they open a different project.
//  · COLLAPSED GROUPS are per project. A sixty-six-book Bible and a four-file
//    dub want completely different folds, and carrying one project's folds to
//    the next would hide rows the reader never chose to hide.

import { PLAN_GROUP_ORDER, type PlanUnitStatus } from "./plan-status"

/**
 * How the board is arranged.
 *
 *  · `status` — grouped by urgency, the default. The grouping IS the answer:
 *    what needs attention today is readable before any single row is.
 *  · `order`  — one flat list in the order the server sent, which is canonical
 *    book order and then name. Answers "walk me through the project" instead,
 *    and puts a status pill back on every row since no header carries it.
 */
export type PlanViewMode = "status" | "order"

export const DEFAULT_PLAN_VIEW: PlanViewMode = "status"

const VIEW_STORAGE_KEY = "aquilla:planView"
const GROUPS_STORAGE_KEY_PREFIX = "aquilla:planGroups:"

function isPlanViewMode(value: unknown): value is PlanViewMode {
  return value === "status" || value === "order"
}

/** The reader's arrangement, or the default when unset or unreadable. */
export function loadPlanView(): PlanViewMode {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY)
    return isPlanViewMode(raw) ? raw : DEFAULT_PLAN_VIEW
  } catch {
    return DEFAULT_PLAN_VIEW
  }
}

/** Persist the arrangement. Silently no-ops if storage is unavailable. */
export function savePlanView(mode: PlanViewMode): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, mode)
  } catch {
    /* storage unavailable (private mode, quota) — preference is best-effort */
  }
}

function isPlanUnitStatus(value: unknown): value is PlanUnitStatus {
  return typeof value === "string" && (PLAN_GROUP_ORDER as readonly string[]).includes(value)
}

/**
 * Which status groups this project's reader has folded away.
 *
 * Unknown entries are dropped rather than thrown — a status retired in a later
 * release must not blank the board for someone who had folded it.
 */
export function loadCollapsedGroups(projectId: string | null): Set<PlanUnitStatus> {
  if (!projectId) return new Set()
  try {
    const raw = localStorage.getItem(`${GROUPS_STORAGE_KEY_PREFIX}${projectId}`)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter(isPlanUnitStatus))
  } catch {
    return new Set()
  }
}

/** Persist the folded set for one project, in canonical group order. */
export function saveCollapsedGroups(projectId: string | null, collapsed: Set<PlanUnitStatus>): void {
  if (!projectId) return
  try {
    const ordered = PLAN_GROUP_ORDER.filter((s) => collapsed.has(s))
    localStorage.setItem(`${GROUPS_STORAGE_KEY_PREFIX}${projectId}`, JSON.stringify(ordered))
  } catch {
    /* storage unavailable — preference is best-effort */
  }
}

/** A new set with one group's fold flipped. Pure; callers persist the result. */
export function toggleCollapsedGroup(
  collapsed: Set<PlanUnitStatus>,
  status: PlanUnitStatus,
): Set<PlanUnitStatus> {
  const next = new Set(collapsed)
  if (next.has(status)) next.delete(status)
  else next.add(status)
  return next
}
