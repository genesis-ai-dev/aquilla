// AQU-1278, round 6: who is on each board row.
//
// Two sources answer that question and they arrive at different times. The
// project-wide read (`getProjectUnitAssignees`) lands once, for every unit, and
// is what lets a row draw its chips from the first paint. The per-unit read
// the inspector fires when a unit is opened lands later, for that unit only,
// and is the fresher of the two right after an assignment is made from the
// panel. This module is the one place that says how they combine, so the
// board and its tests agree without either reading the other's mind.

import { planUnitId, type PlanUnit } from "./plan-status"

/** One face on a row. */
export interface PlanAssignee {
  userId: number
  username: string | null
}

/** One person on one unit, as the project-wide read returns them. */
export interface UnitAssigneeRow {
  fileId: string
  sectionKey: string
  userId: number
  username: string | null
}

/** De-duplicate by user, keeping first-seen order: one face per person. */
function distinctByUser(rows: readonly PlanAssignee[]): PlanAssignee[] {
  const byUser = new Map<number, PlanAssignee>()
  for (const row of rows) if (!byUser.has(row.userId)) byUser.set(row.userId, row)
  return [...byUser.values()]
}

/**
 * The map the board reads: unit id → the people on it.
 *
 * THREE STATES PER UNIT, and the difference between two of them is the whole
 * reason the "unassigned" line exists. A unit ABSENT from the map has not been
 * answered — the project-wide read is still in flight, or the org's floor
 * refused it — and the row says nothing about people. A unit mapped to an
 * EMPTY list was answered "nobody", and the row says "unassigned". So once
 * `projectWide` has arrived, EVERY unit is in the map, empty or not; before
 * it, only the units the inspector has learned are.
 *
 * `perUnit` overlays `projectWide` where it has been read. Right after an
 * assignment is made from the inspector both reads refresh, but the per-unit
 * one is the panel's own and is never staler than the map it feeds.
 */
export function mergeUnitAssignees(
  units: readonly PlanUnit[],
  projectWide: readonly UnitAssigneeRow[] | null,
  perUnit: (unitId: string) => readonly PlanAssignee[] | undefined,
): Map<string, PlanAssignee[]> {
  const wide = new Map<string, PlanAssignee[]>()
  if (projectWide) {
    for (const row of projectWide) {
      const unitId = planUnitId({ fileId: row.fileId, sectionKey: row.sectionKey })
      let list = wide.get(unitId)
      if (!list) {
        list = []
        wide.set(unitId, list)
      }
      list.push({ userId: row.userId, username: row.username })
    }
  }
  const out = new Map<string, PlanAssignee[]>()
  for (const unit of units) {
    const unitId = planUnitId(unit)
    const own = perUnit(unitId)
    if (own) out.set(unitId, distinctByUser(own))
    else if (projectWide) out.set(unitId, distinctByUser(wide.get(unitId) ?? []))
  }
  return out
}
