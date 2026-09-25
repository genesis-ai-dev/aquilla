// Read-side helpers for the assignment.* projection (Phase C, slice 1).
//
// Progress is DERIVED ON READ: an assignment's `cells_done` is the count of its
// assignment_cells whose paired TARGET cell is validated. assignment_cells hold
// the resolved SOURCE cells (file_id, cell_id); validation lands on the target
// row at the same (project_id, file_id, cell_id) — they share cell_id (AD-2).
// So the join is assignment_cells -> cells ON (file_id, cell_id) WHERE
// side='target' AND validated=1. This keeps slice 1 off the hot cell.commit
// path (no stored progress counter).
//
// AQU-1068: the DENOMINATOR is now derived the same way, for the same reason
// one level up. `assignments.cells_total` is a stored column stamped once at
// assignment.create and never recomputed, so a cell removed from a file
// afterwards left its assignment counting a row that no longer exists —
// permanently short of 100%, with nothing a person could do about it. Cells
// only became removable in general with AQU-1068, which is what turned a
// latent inconsistency into a reachable one. Deriving both halves from the
// live `cells` projection makes a removal self-healing.
//
// The stored column stays — assignment-events.ts still stamps it and the
// agent's SQL surface documents it — it is simply no longer what anybody
// reads.

import type { Env } from "../types"
import { bookKeyExpr, sectionKeyExpr } from "../../../db/shared/plan-keys"
import { planUnitsSql } from "../../../db/shared/plan-units"
import { AUDIO_CTE_SQL } from "../../../db/shared/audio-progress"

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

/** The denominator: assigned cells that still EXIST, counted live. Mirrors
 *  CELLS_DONE_SUBQUERY's join without the validated predicate; `side =
 *  'source'` is what makes each assigned cell count exactly once, since
 *  assignment_cells resolved source rows. */
const CELLS_TOTAL_SUBQUERY = `(
  SELECT COUNT(*) FROM assignment_cells ac
    JOIN cells c ON c.project_id = a.project_id AND c.file_id = ac.file_id
                 AND c.cell_id = ac.cell_id AND c.side = 'source'
   WHERE ac.assignment_id = a.assignment_id
)`

/**
 * The numerator: assigned cells whose TARGET row is validated — in the lane the
 * assignment is pinned to.
 *
 * AQU-1278 fixed the lane predicate. `cells` keys on (project, file, cell,
 * side, target_lang), so a multi-lane project holds one target row per lane;
 * without `c.target_lang = a.target_lang` a cell validated in Spanish AND
 * French counted twice, and cellsDone could exceed cellsTotal (the denominator
 * counts SOURCE rows, which are lane-independent — one per cell). That was on
 * screen in two places: the project Team card
 * (GET /:projectId/assignments/all) and the org-wide manager workload view
 * (GET /orgs/:orgId/assignments/workload). Both columns silently over-counted
 * exactly on the projects that need them most — the ones with several lanes.
 *
 * `a.target_lang` rather than a bound lane is deliberate: an assignment IS
 * pinned to one lane (AQU-538 §3.5, '' = the default lane), so its progress is
 * only ever measured in that lane.
 */
const CELLS_DONE_SUBQUERY = `(
  SELECT COUNT(*) FROM assignment_cells ac
    JOIN cells c ON c.project_id = a.project_id AND c.file_id = ac.file_id
                 AND c.cell_id = ac.cell_id AND c.side = 'target'
                 AND c.target_lang = a.target_lang AND c.validated = 1
   WHERE ac.assignment_id = a.assignment_id
)`

/**
 * One open assignment in the org-wide "Team workload" manager view, with its
 * project attribution (AQU-494: a bare per-assignee rollup couldn't say which
 * project an assignment belonged to once a member had work in more than one
 * project — one row per assignment fixes that). `fileId` is one of the
 * assignment's resolved cells' files, carried so the caller can route an
 * unassign event's sync-token request without a second lookup; it's null
 * only for the edge case of a scope that resolved to zero cells.
 */
export interface OrgAssignmentRow {
  assignmentId: string
  projectId: string
  projectName: string
  fileId: string | null
  assigneeUserId: number
  username: string | null
  scopeLabel: string
  /** AQU-538 (§3.5): target-language lane. '' = default lane. */
  targetLang: string
  cellsTotal: number
  cellsDone: number
  deadline: string | null
}

/**
 * Every open assignment across an org's ACTIVE (non-archived) projects, with
 * project + progress attribution — the manager workload view (AQU-494).
 * Newest first.
 */
export async function getOrgAssignmentWorkload(
  env: Env,
  orgId: number,
): Promise<OrgAssignmentRow[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT a.assignment_id    AS assignment_id,
            a.project_id       AS project_id,
            p.name             AS project_name,
            a.assignee_user_id AS assignee_user_id,
            u.username         AS assignee_username,
            a.scope_label      AS scope_label,
            a.target_lang      AS target_lang,
            ${CELLS_TOTAL_SUBQUERY} AS cells_total,
            ${CELLS_DONE_SUBQUERY} AS cells_done,
            a.deadline         AS deadline,
            (SELECT ac.file_id FROM assignment_cells ac
              WHERE ac.assignment_id = a.assignment_id LIMIT 1) AS file_id
       FROM assignments a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN users u ON u.id = a.assignee_user_id
      WHERE p.org_id = ? AND p.archived_at IS NULL
        AND a.unassigned_at IS NULL AND a.completed_at IS NULL
      ORDER BY a.created_at DESC`,
  )
    .bind(orgId)
    .all<{
      assignment_id: string
      project_id: string
      project_name: string
      assignee_user_id: number
      assignee_username: string | null
      scope_label: string
      target_lang: string
      cells_total: number
      cells_done: number
      deadline: string | null
      file_id: string | null
    }>()

  return (rows.results ?? []).map((r) => ({
    assignmentId: r.assignment_id,
    projectId: r.project_id,
    projectName: r.project_name,
    fileId: r.file_id,
    assigneeUserId: r.assignee_user_id,
    username: r.assignee_username,
    scopeLabel: r.scope_label,
    targetLang: r.target_lang ?? "",
    cellsTotal: r.cells_total,
    cellsDone: r.cells_done,
    deadline: r.deadline,
  }))
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
            ${CELLS_TOTAL_SUBQUERY} AS cells_total,
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

/**
 * One live assignment covering a planning unit, with that assignee's OWN
 * progress — every count below is over that assignment's cells inside this
 * unit and nothing else.
 */
export interface UnitAssignment {
  assignmentId: string
  assigneeUserId: number
  username: string | null
  scopeLabel: string
  /** AQU-538 (§3.5): the lane this assignment is pinned to. '' = default. */
  targetLang: string
  deadline: string | null
  /** The assignment's cells that are inside this unit and still exist. */
  cellsTotal: number
  translated: number
  validated: number
  recorded: number
  audioValidated: number
  /**
   * AQU-1278: the same five counts again, broken out per chapter, in canonical
   * order. Summing any column across this array gives the aggregate above it.
   *
   * COUNTS, not a ready-made "these chapters are short" list, and the choice
   * matters. What counts as short is `planUnitShortfall` on the client — it
   * owns the zero clamp and `AUDIO_JUDGED_ON_RECORDED`, the flag that flips
   * the day AQU-490 ships a recording-review UI. A `shortChapters` computed
   * here would be a second copy of that rule, in another language, on the far
   * side of a wire, and it would keep answering the old question after the
   * flag moved. Handing over the numbers keeps one definition.
   */
  chapters: UnitAssignmentChapter[]
}

/** One chapter's share of an assignment. `key` is a section key: "GEN 12". */
export interface UnitAssignmentChapter {
  key: string
  total: number
  translated: number
  validated: number
  recorded: number
  audioValidated: number
}

/** Endorsement-count cap, mirroring progress-read-route's MAX_VALIDATION_LEVELS. */
const MAX_VALIDATION_LEVEL = 15

/**
 * The endorsement count at which a cell reads as validated, for this project.
 *
 * The plan board's bars compute validated LIVE — a cell counts when its
 * endorsement_count meets the project's CURRENT threshold — so this panel has
 * to as well. `cells.validated` is stamped against whatever the threshold was
 * at commit time; raise validationCount from 1 to 2 and the stamp says yes
 * where the bar beside it says no. Two numbers on one panel, disagreeing.
 *
 * Same source of truth and same clamp as sync-worker's
 * progress-read-route.ts#readValidationCount (default 1, cap 15), read through
 * the `validation_count` generated column so we never parse the settings blob.
 */
async function readValidationCount(env: Env, projectId: string): Promise<number> {
  return readThreshold(env, projectId, "validation_count")
}

/**
 * AQU-490: the audio twin, read through its own generated column (0096) for
 * the same reason — the settings blob runs to megabytes and this panel is on
 * the plan inspector's hot path.
 */
async function readValidationCountAudio(env: Env, projectId: string): Promise<number> {
  return readThreshold(env, projectId, "validation_count_audio")
}

async function readThreshold(
  env: Env,
  projectId: string,
  column: "validation_count" | "validation_count_audio",
): Promise<number> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT ${column} AS threshold FROM project_settings WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ threshold: string | number | null }>()
  const value = Math.floor(Number(row?.threshold))
  return Number.isFinite(value) ? Math.min(MAX_VALIDATION_LEVEL, Math.max(1, value)) : 1
}

/**
 * Every live assignment covering ONE planning unit (project + file +
 * sectionKey + lane), each with its assignee's own four-term progress inside
 * that unit — the plan inspector's "Assigned to" section.
 *
 * `sectionKey` is '' for a file-grain unit and a Bible book code ("GEN") for a
 * sub-file one. A file-grain unit IS the whole file, so it takes no section
 * predicate; a book unit filters on bookKeyExpr, the same expression
 * sync-worker builds file_section_progress's book rows from
 * (db/shared/plan-keys.ts). Deriving membership any other way would let this
 * panel count a different set of cells than the bar directly above it.
 *
 * LANES. The four counts are measured in the lane the inspector is showing,
 * not in each assignment's own lane, so they can be read against that lane's
 * bar. An assignment pinned to a DIFFERENT lane still appears — the cells are
 * spoken for either way, and hiding the row would make the unit look
 * unassigned — which is why every row carries its own `targetLang` for the
 * caller to label. Audio has no lane at all (below).
 */
export async function getUnitAssignments(
  env: Env,
  projectId: string,
  fileId: string,
  sectionKey: string,
  lane: string,
): Promise<UnitAssignment[]> {
  const [validationCount, validationCountAudio] = await Promise.all([
    readValidationCount(env, projectId),
    readValidationCountAudio(env, projectId),
  ])

  // A book unit filters by book key; a file-grain unit ('') does not filter at
  // all. Built as a fragment so the bind only exists when the predicate does.
  const sectionPredicate = sectionKey === "" ? "" : `AND (${bookKeyExpr("c")}) = ?`

  const rows = await env.AQUILLA_PG.prepare(
    // The audio CTE is lifted from sync-worker's AUDIO_CTE_SQL, verbatim
    // definitions: a cell HAS audio when any take is live (deleted = 0) —
    // recording it is what counts, not selecting it — and its audio is
    // VALIDATED when its SELECTED take is approved, so a re-record drops
    // validation. Pre-grouping by cell_id is load-bearing: cell_audio keys on
    // four columns (project, file, cell, audio_id) where cells keys on five,
    // so joining takes straight onto the cell rows would multiply every other
    // count by the number of takes.
    //
    // cell_audio has NO target_lang column, so audio is lane-independent BY
    // CONSTRUCTION — one recording is the recording, whichever text lane you
    // are looking at. That is a schema fact, not a simplification here.
    `WITH policy AS (
       -- AQU-1083. Whether chapter headings and section titles count as
       -- translatable content is a team setting: the project's answer, else its
       -- org's, else yes. Read from the STORED generated columns, never by
       -- parsing the settings blob, which runs to several megabytes and is what
       -- timed the org dashboard out at fifteen seconds once already.
       --
       -- It has to be here, and it is the whole reason this CTE exists: the bar
       -- drawn directly above this panel has the structural cells SUBTRACTED
       -- from it whenever the policy excludes them. Counting them here would
       -- put "Anna: 940 of 952" under a bar whose own denominator is 940, on
       -- one screen, with nothing to explain the twelve.
       SELECT COALESCE(COALESCE(ps.count_structural, os.count_structural) = 'false', false)
                AS exclude_structural
         FROM projects p
         LEFT JOIN project_settings ps ON ps.project_id = p.id
         LEFT JOIN org_settings os ON os.org_id = p.org_id
        WHERE p.id = ?
     ), audio AS (
       -- AQU-490: the shared definition, not a fourth hand-copy of it. This
       -- panel sits directly under the unit's own audio bar, so the two must
       -- count the same cells by construction rather than by agreement.
       ${AUDIO_CTE_SQL}
     )
     SELECT a.assignment_id    AS assignment_id,
            a.assignee_user_id AS assignee_user_id,
            u.username         AS assignee_username,
            a.scope_label      AS scope_label,
            a.target_lang      AS target_lang,
            a.deadline         AS deadline,
            -- AQU-1278. One row per (assignment, chapter) rather than per
            -- assignment: the inspector needs to say WHICH chapters a person
            -- still owes work in, and which chapters of the unit nobody holds.
            -- The aggregate the panel already showed is the sum over these,
            -- folded below, so no existing number moves.
            ${sectionKeyExpr("c")} AS chapter_key,
            COUNT(*)::integer AS cells_total,
            COUNT(*) FILTER (WHERE TRIM(COALESCE(t.value, '')) <> '')::integer AS translated,
            COUNT(*) FILTER (WHERE COALESCE(t.endorsement_count, 0) >= ?)::integer AS validated,
            COUNT(*) FILTER (WHERE COALESCE(au.has_dub, 0) = 1)::integer AS recorded,
            -- Against the project's CURRENT audio threshold, for the same
            -- reason the text count above it is: a stored verdict would disagree
            -- with the bar drawn above this panel the moment somebody changed
            -- the required number.
            COUNT(*) FILTER (WHERE au.dub_votes >= ?)::integer AS audio_validated
       FROM assignments a
       JOIN assignment_cells ac ON ac.assignment_id = a.assignment_id
       -- SOURCE rows are the denominator, exactly as in CELLS_TOTAL_SUBQUERY:
       -- they are what assignment_cells resolved, they are lane-independent,
       -- and a cell removed from the file drops out of the count instead of
       -- stranding the assignment short of 100% forever (AQU-1068).
       JOIN cells c ON c.project_id = a.project_id AND c.file_id = ac.file_id
                   AND c.cell_id = ac.cell_id AND c.side = 'source'
       LEFT JOIN cells t ON t.project_id = c.project_id AND t.file_id = c.file_id
                        AND t.cell_id = c.cell_id AND t.side = 'target'
                        AND t.target_lang = ?
       LEFT JOIN audio au ON au.cell_id = c.cell_id
       LEFT JOIN users u ON u.id = a.assignee_user_id
       CROSS JOIN policy pol
      WHERE a.project_id = ? AND ac.file_id = ?
        AND a.unassigned_at IS NULL AND a.completed_at IS NULL
        -- The SOURCE alias, always. Target rows carry no type at all, so the
        -- same predicate written against t would be NULL on every row.
        --
        -- COALESCE, and it is not defensive noise: a null type MEANS content,
        -- but SQL does not agree. \`NULL IN ('heading','paratext')\` is NULL, so
        -- \`NOT (true AND NULL)\` is NULL, and WHERE drops a NULL row exactly as
        -- it drops a false one — every untyped cell in the unit would vanish
        -- the moment a team turned headings off, and the panel would go blank
        -- rather than wrong, which is worse to diagnose. A test pins this.
        AND NOT (pol.exclude_structural AND COALESCE(c.type, '') IN ('heading', 'paratext'))
        ${sectionPredicate}
      GROUP BY a.assignment_id, a.assignee_user_id, u.username, a.scope_label,
               a.target_lang, a.deadline, a.created_at, ${sectionKeyExpr("c")}
      ORDER BY a.created_at DESC, a.assignment_id`,
  )
    // Binds are positional, so they follow the statement's own order: the
    // policy CTE's project, the audio CTE's (project, file), the text then
    // audio thresholds in the SELECT list, the lane on the target join, then the
    // WHERE — and the section key last, only when the fragment above put a
    // placeholder there. Adding a CTE ahead of another means inserting its
    // binds ahead of theirs; there is no naming here to catch a mistake.
    .bind(
      projectId,
      projectId,
      fileId,
      validationCount,
      validationCountAudio,
      lane,
      projectId,
      fileId,
      ...(sectionKey === "" ? [] : [sectionKey]),
    )
    .all<{
      assignment_id: string
      assignee_user_id: number
      assignee_username: string | null
      scope_label: string
      target_lang: string
      deadline: string | null
      chapter_key: string
      cells_total: number
      translated: number
      validated: number
      recorded: number
      audio_validated: number
    }>()

  // Fold the per-chapter rows back into one entry per assignment, summing as we
  // go. A Map keyed on the assignment id preserves FIRST-SEEN order, which is
  // the ORDER BY's order (newest assignment first) — the order this panel has
  // always listed people in, and one the caller must not have to restore.
  const byAssignment = new Map<string, UnitAssignment>()
  for (const r of rows.results ?? []) {
    let entry = byAssignment.get(r.assignment_id)
    if (!entry) {
      entry = {
        assignmentId: r.assignment_id,
        assigneeUserId: r.assignee_user_id,
        username: r.assignee_username,
        scopeLabel: r.scope_label,
        targetLang: r.target_lang ?? "",
        deadline: r.deadline,
        cellsTotal: 0,
        translated: 0,
        validated: 0,
        recorded: 0,
        audioValidated: 0,
        chapters: [],
      }
      byAssignment.set(r.assignment_id, entry)
    }
    entry.cellsTotal += r.cells_total
    entry.translated += r.translated
    entry.validated += r.validated
    entry.recorded += r.recorded
    entry.audioValidated += r.audio_validated
    entry.chapters.push({
      key: r.chapter_key,
      total: r.cells_total,
      translated: r.translated,
      validated: r.validated,
      recorded: r.recorded,
      audioValidated: r.audio_validated,
    })
  }

  // Canonical order within each assignment, so "GEN 2" precedes "GEN 10" and a
  // caller can take the first short chapter as THE one to name. Across books —
  // only reachable on a file-grain unit — this falls back to the book CODE's
  // alphabetical order, not the canon's: auth-worker has no book table, and
  // importing one to sort a line that says "ch. 12" is not a trade worth making.
  for (const entry of byAssignment.values()) {
    entry.chapters.sort((a, b) => {
      const ka = chapterSortKey(a.key)
      const kb = chapterSortKey(b.key)
      return ka.book === kb.book ? ka.num - kb.num : ka.book.localeCompare(kb.book)
    })
  }
  return [...byAssignment.values()]
}

/** A single open assignment in the caller's inbox. */
export interface MyAssignment {
  assignmentId: string
  projectId: string
  /**
   * AQU-690: the file the assignment's scope resolved to (one of its resolved
   * cells' files), so the Editor's "My assignments" click can open the right
   * file. Mirrors the workload read's `file_id` subquery; null only when the
   * scope resolved to zero cells.
   */
  fileId: string | null
  /** Display name for `fileId` from `files.name`; null when `fileId` is null. */
  fileName: string | null
  /**
   * AQU-894: EVERY file the assignment's resolved cells touch, ascending.
   *
   * `fileId` above is one arbitrary member of this set (`LIMIT 1`), which is
   * all the inbox's "open the right file" click needs. It cannot answer "is
   * this file mine?", because a books-scope assignment over GEN + EXO reports
   * one of the two and says nothing about the other — so a sidebar reading
   * `fileId` alone would mark half a person's own work as somebody else's.
   * Empty only when the scope resolved to zero cells.
   */
  fileIds: string[]
  scopeKind: string
  scopeLabel: string
  /** AQU-538 (§3.5): target-language lane. '' = default lane. */
  targetLang: string
  deadline: string | null
  note: string | null
  cellsTotal: number
  cellsDone: number
  createdAt: number
}

/**
 * assignment_id → the distinct files its resolved cells live in (AQU-894).
 *
 * A second read rather than an aggregate in the inbox query itself: the inbox
 * is a once-per-project-open read, and one plain SELECT that any Postgres
 * driver returns as plain rows is worth more here than saving a round trip on
 * a `json_agg` whose shape depends on how the driver decodes a JSON column.
 *
 * Callers pass the assignment ids they already selected, so this inherits
 * their authorization exactly — it never widens what the caller may see.
 */
async function fileIdsForAssignments(
  env: Env,
  assignmentIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byAssignment = new Map<string, string[]>()
  for (const id of assignmentIds) byAssignment.set(id, [])
  if (assignmentIds.length === 0) return byAssignment

  const placeholders = assignmentIds.map(() => "?").join(", ")
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT DISTINCT ac.assignment_id AS assignment_id, ac.file_id AS file_id
       FROM assignment_cells ac
      WHERE ac.assignment_id IN (${placeholders})
      ORDER BY ac.assignment_id, ac.file_id`,
  )
    .bind(...assignmentIds)
    .all<{ assignment_id: string; file_id: string }>()

  for (const r of rows.results ?? []) byAssignment.get(r.assignment_id)?.push(r.file_id)
  return byAssignment
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
            a.target_lang AS target_lang,
            a.deadline AS deadline, a.note AS note,
            ${CELLS_TOTAL_SUBQUERY} AS cells_total, a.created_at AS created_at,
            ${CELLS_DONE_SUBQUERY} AS cells_done,
            (SELECT ac.file_id FROM assignment_cells ac
              WHERE ac.assignment_id = a.assignment_id LIMIT 1) AS file_id,
            (SELECT f.name FROM assignment_cells ac
               JOIN files f ON f.id = ac.file_id AND f.project_id = a.project_id
              WHERE ac.assignment_id = a.assignment_id LIMIT 1) AS file_name
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
      target_lang: string
      deadline: string | null
      note: string | null
      cells_total: number
      created_at: number
      cells_done: number
      file_id: string | null
      file_name: string | null
    }>()

  const results = rows.results ?? []
  const fileIds = await fileIdsForAssignments(env, results.map((r) => r.assignment_id))

  return results.map((r) => ({
    assignmentId: r.assignment_id,
    projectId: r.project_id,
    fileId: r.file_id,
    fileName: r.file_name,
    fileIds: fileIds.get(r.assignment_id) ?? [],
    scopeKind: r.scope_kind,
    scopeLabel: r.scope_label,
    targetLang: r.target_lang ?? "",
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
            a.target_lang AS target_lang,
            a.deadline AS deadline, a.note AS note,
            ${CELLS_TOTAL_SUBQUERY} AS cells_total, a.created_at AS created_at,
            ${CELLS_DONE_SUBQUERY} AS cells_done,
            (SELECT ac.file_id FROM assignment_cells ac
              WHERE ac.assignment_id = a.assignment_id LIMIT 1) AS file_id,
            (SELECT f.name FROM assignment_cells ac
               JOIN files f ON f.id = ac.file_id AND f.project_id = a.project_id
              WHERE ac.assignment_id = a.assignment_id LIMIT 1) AS file_name
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
      target_lang: string
      deadline: string | null
      note: string | null
      cells_total: number
      created_at: number
      cells_done: number
      file_id: string | null
      file_name: string | null
    }>()

  const results = rows.results ?? []
  const fileIds = await fileIdsForAssignments(env, results.map((r) => r.assignment_id))

  return results.map((r) => ({
    assignmentId: r.assignment_id,
    projectId: r.project_id,
    projectName: r.project_name,
    fileId: r.file_id,
    fileName: r.file_name,
    fileIds: fileIds.get(r.assignment_id) ?? [],
    scopeKind: r.scope_kind,
    scopeLabel: r.scope_label,
    targetLang: r.target_lang ?? "",
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

/** One person on one planning unit — the board's avatar chip, and nothing more. */
export interface UnitAssignee {
  fileId: string
  /** '' for a whole file, a book code for a book inside a Scripture file. */
  sectionKey: string
  userId: number
  username: string | null
}

/**
 * AQU-1278, round 6: who is on EVERY unit of a project, in one read.
 *
 * The board draws a face per assignee on each row, and until this existed it
 * could only learn a unit's people from the per-unit read the inspector fires
 * when a unit is opened — so a row showed its chips the moment its inspector
 * had been opened once, and nothing before that. Sam (2026-09-16): people do
 * not show up on the board until the file has been clicked on.
 *
 * Membership is decided the way the plan decides what a unit IS: the same
 * `planUnitsSql` the board's rows come from, joined to each assigned cell by
 * the book key the projection derives. A file with book rows has no
 * file-grain unit and vice versa, which is what lets one predicate serve both
 * shapes. The structural policy applies for parity with `getUnitAssignments`:
 * a person whose whole assignment is headings the project does not count is
 * not on the inspector's list, so they are not on the row either.
 *
 * Live assignments only; one row per (unit, person); newest assignment first
 * within a unit, matching the order the inspector lists people in.
 */
export async function getProjectUnitAssignees(env: Env, projectId: string): Promise<UnitAssignee[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `WITH policy AS (
       SELECT COALESCE(COALESCE(ps.count_structural, os.count_structural) = 'false', false)
                AS exclude_structural
         FROM projects p
         LEFT JOIN project_settings ps ON ps.project_id = p.id
         LEFT JOIN org_settings os ON os.org_id = p.org_id
        WHERE p.id = ?
     ), units AS (${planUnitsSql("f.project_id = ?")})
     SELECT u.file_id           AS file_id,
            u.section_key       AS section_key,
            a.assignee_user_id  AS user_id,
            usr.username        AS username,
            MAX(a.created_at)   AS latest
       FROM assignments a
       JOIN assignment_cells ac ON ac.assignment_id = a.assignment_id
       JOIN cells c ON c.project_id = a.project_id AND c.file_id = ac.file_id
                   AND c.cell_id = ac.cell_id AND c.side = 'source'
       -- A file with book units has no '' unit and a file without has only
       -- the '' unit, so this OR is exact rather than lenient.
       JOIN units u ON u.project_id = c.project_id AND u.file_id = c.file_id
                   AND (u.section_key = '' OR u.section_key = ${bookKeyExpr("c")})
       LEFT JOIN users usr ON usr.id = a.assignee_user_id
       CROSS JOIN policy pol
      WHERE a.project_id = ? AND a.unassigned_at IS NULL AND a.completed_at IS NULL
        AND NOT (pol.exclude_structural AND COALESCE(c.type, '') IN ('heading', 'paratext'))
      GROUP BY u.file_id, u.section_key, a.assignee_user_id, usr.username
      ORDER BY u.file_id, u.section_key, latest DESC, a.assignee_user_id`,
  )
    // Positional: the policy CTE's project, the units CTE's project, the WHERE.
    .bind(projectId, projectId, projectId)
    .all<{ file_id: string; section_key: string; user_id: number; username: string | null }>()
  return (rows.results ?? []).map((r) => ({
    fileId: r.file_id,
    sectionKey: r.section_key,
    userId: r.user_id,
    username: r.username,
  }))
}
