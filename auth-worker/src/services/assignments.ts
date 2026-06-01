// Read-side helpers for the assignment.* projection (Phase C, slice 1).
//
// Progress is DERIVED ON READ: an assignment's `cells_done` is the count of its
// assignment_cells whose paired TARGET cell is validated. assignment_cells hold
// the resolved SOURCE cells (file_id, cell_id); validation lands on the target
// row at the same (project_id, file_id, cell_id) — they share cell_id (AD-2).
// So the join is assignment_cells -> cells ON (file_id, cell_id) WHERE
// side='target' AND validated=1. This keeps slice 1 off the hot cell.commit
// path (no stored progress counter).

import type { Env } from "../types"

/** Per-assignee rollup for the manager workload view. */
export interface AssigneeWorkload {
  userId: number
  username: string | null
  /** Open (not unassigned, not completed) assignments for this assignee. */
  openAssignments: number
  /** Sum of assigned cells across those assignments (the denominator). */
  cellsTotal: number
  /** Sum of validated assigned cells across those assignments (derived). */
  cellsDone: number
}

const CELLS_DONE_SUBQUERY = `(
  SELECT COUNT(*) FROM assignment_cells ac
    JOIN cells c ON c.project_id = a.project_id AND c.file_id = ac.file_id
                 AND c.cell_id = ac.cell_id AND c.side = 'target' AND c.validated = 1
   WHERE ac.assignment_id = a.assignment_id
)`

/**
 * Per-assignee open workload + derived progress across an org's ACTIVE
 * (non-archived) projects. One row per open assignment is fetched then rolled
 * up per assignee in JS (the cells_done subquery is per-assignment).
 */
export async function getOrgAssignmentWorkload(
  env: Env,
  orgId: number,
): Promise<AssigneeWorkload[]> {
  const rows = await env.AQUILLA_DB.prepare(
    `SELECT a.assignee_user_id AS assignee_user_id,
            u.username         AS assignee_username,
            a.cells_total      AS cells_total,
            ${CELLS_DONE_SUBQUERY} AS cells_done
       FROM assignments a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN users u ON u.id = a.assignee_user_id
      WHERE p.org_id = ? AND p.archived_at IS NULL
        AND a.unassigned_at IS NULL AND a.completed_at IS NULL`,
  )
    .bind(orgId)
    .all<{
      assignee_user_id: number
      assignee_username: string | null
      cells_total: number
      cells_done: number
    }>()

  const byUser = new Map<number, AssigneeWorkload>()
  for (const r of rows.results ?? []) {
    let w = byUser.get(r.assignee_user_id)
    if (!w) {
      w = {
        userId: r.assignee_user_id,
        username: r.assignee_username,
        openAssignments: 0,
        cellsTotal: 0,
        cellsDone: 0,
      }
      byUser.set(r.assignee_user_id, w)
    }
    w.openAssignments += 1
    w.cellsTotal += r.cells_total
    w.cellsDone += r.cells_done
  }
  // Most outstanding work (largest remaining) first — the manager's attention
  // order.
  return [...byUser.values()].sort(
    (a, b) => b.cellsTotal - b.cellsDone - (a.cellsTotal - a.cellsDone),
  )
}

/** A single open assignment in the caller's inbox. */
export interface MyAssignment {
  assignmentId: string
  projectId: string
  scopeKind: string
  scopeLabel: string
  deadline: string | null
  note: string | null
  cellsTotal: number
  cellsDone: number
  createdAt: number
}

/**
 * The caller's open assignments in one project (the "Assigned to me" inbox).
 * Newest first.
 */
export async function getMyAssignments(
  env: Env,
  projectId: string,
  userId: number,
): Promise<MyAssignment[]> {
  const rows = await env.AQUILLA_DB.prepare(
    `SELECT a.assignment_id AS assignment_id, a.project_id AS project_id,
            a.scope_kind AS scope_kind, a.scope_label AS scope_label,
            a.deadline AS deadline, a.note AS note,
            a.cells_total AS cells_total, a.created_at AS created_at,
            ${CELLS_DONE_SUBQUERY} AS cells_done
       FROM assignments a
      WHERE a.project_id = ? AND a.assignee_user_id = ?
        AND a.unassigned_at IS NULL AND a.completed_at IS NULL
      ORDER BY a.created_at DESC`,
  )
    .bind(projectId, userId)
    .all<{
      assignment_id: string
      project_id: string
      scope_kind: string
      scope_label: string
      deadline: string | null
      note: string | null
      cells_total: number
      created_at: number
      cells_done: number
    }>()

  return (rows.results ?? []).map((r) => ({
    assignmentId: r.assignment_id,
    projectId: r.project_id,
    scopeKind: r.scope_kind,
    scopeLabel: r.scope_label,
    deadline: r.deadline,
    note: r.note,
    cellsTotal: r.cells_total,
    cellsDone: r.cells_done,
    createdAt: r.created_at,
  }))
}
