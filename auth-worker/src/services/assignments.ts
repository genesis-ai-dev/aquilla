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
  const rows = await env.AQUILLA_PG.prepare(
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

/**
 * Per-assignee open workload + derived progress scoped to ONE project.
 * Returns every assignee who has at least one open assignment in the project,
 * sorted by remaining work descending (same order as the org workload view).
 * Requires the caller to be maintainer+ on the project (enforced in the route).
 */
export async function getProjectAssignmentRoster(
  env: Env,
  projectId: string,
): Promise<AssigneeWorkload[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT a.assignee_user_id AS assignee_user_id,
            u.username         AS assignee_username,
            a.cells_total      AS cells_total,
            ${CELLS_DONE_SUBQUERY} AS cells_done
       FROM assignments a
       LEFT JOIN users u ON u.id = a.assignee_user_id
      WHERE a.project_id = ?
        AND a.unassigned_at IS NULL AND a.completed_at IS NULL`,
  )
    .bind(projectId)
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
  const rows = await env.AQUILLA_PG.prepare(
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

/** One of the caller's open assignments, with its project name (org-wide inbox). */
export interface MyOrgAssignment extends MyAssignment {
  projectName: string
}

/**
 * The caller's open assignments across ALL of an org's active projects, in ONE
 * query. Replaces the per-project fan-out (the client used to call
 * /:projectId/assignments/mine once per project — N requests, N connections).
 * Authorization is the route's org-membership check; rows are inherently the
 * caller's own (assignee_user_id = userId). Newest first.
 */
export async function getMyAssignmentsAcrossOrg(
  env: Env,
  orgId: number,
  userId: number,
): Promise<MyOrgAssignment[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT a.assignment_id AS assignment_id, a.project_id AS project_id,
            p.name AS project_name,
            a.scope_kind AS scope_kind, a.scope_label AS scope_label,
            a.deadline AS deadline, a.note AS note,
            a.cells_total AS cells_total, a.created_at AS created_at,
            ${CELLS_DONE_SUBQUERY} AS cells_done
       FROM assignments a
       JOIN projects p ON p.id = a.project_id
      WHERE p.org_id = ? AND p.archived_at IS NULL
        AND a.assignee_user_id = ?
        AND a.unassigned_at IS NULL AND a.completed_at IS NULL
      ORDER BY a.created_at DESC`,
  )
    .bind(orgId, userId)
    .all<{
      assignment_id: string
      project_id: string
      project_name: string
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
    projectName: r.project_name,
    scopeKind: r.scope_kind,
    scopeLabel: r.scope_label,
    deadline: r.deadline,
    note: r.note,
    cellsTotal: r.cells_total,
    cellsDone: r.cells_done,
    createdAt: r.created_at,
  }))
}

/** Split "GEN 10" → { book: "GEN", num: 10 } for natural ordering. */
function chapterSortKey(chapter: string): { book: string; num: number } {
  const m = chapter.match(/^(.*?)(\d+)\s*$/)
  if (!m) return { book: chapter, num: 0 }
  return { book: m[1].trim(), num: parseInt(m[2], 10) }
}

/**
 * Distinct chapters present in a file, derived from the source cells'
 * canonical_ref (e.g. "GEN 1:1" → "GEN 1"). Populates the assign picker's
 * chapter dropdown so a manager picks a real chapter instead of typing a
 * canonical-ref prefix — and the value feeds the resolver's LIKE 'GEN 1:%'
 * directly. Natural-sorted (book code, then chapter number) so "GEN 2"
 * precedes "GEN 10".
 */
export async function getFileChapters(
  env: Env,
  projectId: string,
  fileId: string,
): Promise<string[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT DISTINCT substr(canonical_ref, 1, strpos(canonical_ref, ':') - 1) AS chapter
       FROM cells
      WHERE project_id = ? AND file_id = ? AND side = 'source'
        AND canonical_ref IS NOT NULL AND strpos(canonical_ref, ':') > 0`,
  )
    .bind(projectId, fileId)
    .all<{ chapter: string }>()

  const chapters = (rows.results ?? [])
    .map((r) => r.chapter)
    .filter((c): c is string => typeof c === "string" && c.length > 0)
  chapters.sort((a, b) => {
    const ka = chapterSortKey(a)
    const kb = chapterSortKey(b)
    return ka.book === kb.book ? ka.num - kb.num : ka.book.localeCompare(kb.book)
  })
  return chapters
}
