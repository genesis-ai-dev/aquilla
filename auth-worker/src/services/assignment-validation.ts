// AQU-1969: a Validate assignment's progress — the assignee's OWN approvals
// in their scope, for text and for recordings.
//
// A translate assignment's progress is "lines validated by anyone", which
// cannot say whether the person given the validating has done any of it: on a
// project that needs two approvals a line can be validated by two others while
// the assignee never looked at it. Every approval is already stored with who
// gave it, per language — `cell_validators` for text, `cell_audio_validators`
// for recordings — so this counts from those rows and stores nothing new.
//
// The four rules Sam settled (2026-10-15), each line of the scope landing in
// exactly one bucket:
//
//   1. VALIDATED — the assignee's own approval of the line as it reads now:
//      their text vote is pinned to the line's current edit (the vote's
//      `event_id` is the target row's head, the same comparison the
//      projection counts `validated` with), or their audio vote is on every
//      take that sounds on the line (one per track, `takeSoundsOnItsTrackSql`
//      — the rule the shared audio CTE judges a line by).
//   2. WAITING — nothing to approve yet: no translation, or for recordings no
//      recording. Their translator's or recorder's backlog, not theirs, so it
//      is never "left".
//   3. NOT THEIRS — lines they cannot approve leave the count entirely. That
//      is the project's self-validation switch, the one per-line refusal the
//      server makes (route.ts): off, a line they last edited, or a line whose
//      sounding take they recorded, is somebody else's to approve, and
//      counting it would leave them short of 100% forever. A line they had
//      already approved still counts as approved.
//   4. CHANGED SINCE — they approved an earlier version (a vote on an older
//      edit, or on a take that no longer sounds) and not this one. Inside
//      "left", counted separately so the manager can tell "never looked" from
//      "looked, then the text moved".
//
// "Left" is what remains: total − validated − waiting.
//
// Measured in the ASSIGNMENT'S lane, never the lane a screen happens to show:
// an approval belongs to one language, and the same validate assignment has to
// read the same on the plan board, the Team card and the org's Team workload.

import type { Env } from "../types"
import { planKeysJoinSql, unitBookKeyExpr } from "../../../db/shared/plan-keys"
import { audioLaneTagSql, takeSoundsOnItsTrackSql } from "../../../db/shared/audio-progress"

export type AssignmentKind = "translate" | "validate"

/** The stored kind as the wire carries it: 'validate', else the translate default. */
export function assignmentKind(raw: unknown): AssignmentKind {
  return raw === "validate" ? "validate" : "translate"
}

/** One medium's share of a validate assignment. See the rules above. */
export interface ValidationCounts {
  /** Lines theirs to approve: the scope less rule 3's. */
  total: number
  /** Rule 1: their approval of the line as it is now. */
  validated: number
  /** Rule 2: no translation (text) or no recording (audio) yet. */
  waiting: number
  /** Rule 4: approved an earlier version, not this one. Part of "left". */
  changed: number
}

export interface ValidationProgress {
  text: ValidationCounts
  audio: ValidationCounts
}

/** Lines still owed: never negative, never counting what is waiting. */
export function validationLeft(c: ValidationCounts): number {
  return Math.max(0, c.total - c.validated - c.waiting)
}

/**
 * Furthest behind first: most lines left across both media, then most changed
 * since, then by name so equal rows keep a stable order.
 */
export function compareValidationBehind(
  a: { validation: ValidationProgress; username: string | null },
  b: { validation: ValidationProgress; username: string | null },
): number {
  const left = (v: ValidationProgress) => validationLeft(v.text) + validationLeft(v.audio)
  const changed = (v: ValidationProgress) => v.text.changed + v.audio.changed
  return (
    left(b.validation) - left(a.validation) ||
    changed(b.validation) - changed(a.validation) ||
    (a.username ?? "").localeCompare(b.username ?? "")
  )
}

/** Same JSON value the server's self-validation gate refuses on (route.ts). */
const SELF_VALIDATION_OFF_SQL = `COALESCE(ps.wp_allow_self_validation = 'false'::jsonb, false)`
const SELF_VALIDATION_AUDIO_OFF_SQL = `COALESCE(ps.wp_allow_self_validation_audio = 'false'::jsonb, false)`

/** A selected, live dub take — what "recorded" means (AUDIO_CTE_SQL's has_dub). */
const LIVE_DUB = `ca.deleted = 0 AND ca.selected = 1 AND ca.role = 'dub'`

const EMPTY: ValidationCounts = { total: 0, validated: 0, waiting: 0, changed: 0 }

/**
 * The own-approval progress of each listed assignment, keyed by id. Ids that
 * are not validate assignments, or whose scope holds no lines, come back at
 * zero rather than missing, so a caller can attach the result unconditionally.
 *
 * `unit` narrows each assignment to its lines inside one planning unit — the
 * plan inspector's grain, matched exactly as `getUnitAssignments` matches it.
 *
 * Callers pass ids they already selected under their own authorization, so
 * this never widens what a caller may see.
 */
export async function loadValidationProgress(
  env: Env,
  assignmentIds: readonly string[],
  unit?: { fileId: string; sectionKey: string },
): Promise<Map<string, ValidationProgress>> {
  const out = new Map<string, ValidationProgress>()
  for (const id of assignmentIds) out.set(id, { text: { ...EMPTY }, audio: { ...EMPTY } })
  if (assignmentIds.length === 0) return out

  const unitJoin = unit && unit.sectionKey !== "" ? planKeysJoinSql("ac", "ik") : ""
  const unitPredicate = unit
    ? `AND ac.file_id = ?${unit.sectionKey !== "" ? ` AND (${unitBookKeyExpr("ac", "ik")}) = ?` : ""}`
    : ""
  const unitBinds = unit ? [unit.fileId, ...(unit.sectionKey !== "" ? [unit.sectionKey] : [])] : []

  const rows = await env.AQUILLA_PG.prepare(
    `SELECT a.assignment_id AS assignment_id,
            COUNT(*) FILTER (WHERE NOT x.text_cant)::integer AS text_total,
            COUNT(*) FILTER (WHERE x.text_mine)::integer AS text_validated,
            COUNT(*) FILTER (WHERE NOT x.text_cant AND NOT x.text_mine AND NOT x.translated)::integer AS text_waiting,
            COUNT(*) FILTER (WHERE NOT x.text_cant AND NOT x.text_mine AND x.translated AND x.text_voted)::integer AS text_changed,
            COUNT(*) FILTER (WHERE NOT x.audio_cant)::integer AS audio_total,
            COUNT(*) FILTER (WHERE x.audio_mine)::integer AS audio_validated,
            COUNT(*) FILTER (WHERE NOT x.audio_cant AND NOT x.audio_mine AND NOT x.recorded)::integer AS audio_waiting,
            COUNT(*) FILTER (WHERE NOT x.audio_cant AND NOT x.audio_mine AND x.recorded AND x.audio_voted)::integer AS audio_changed
       FROM assignments a
       -- Votes are stored by username; the assignment names a user id.
       JOIN users u ON u.id = a.assignee_user_id
       LEFT JOIN lanes ln ON ln.project_id = a.project_id AND ln.id = a.lane_id
       LEFT JOIN project_settings ps ON ps.project_id = a.project_id
       -- The live SOURCE membership, as every assignment reader counts it.
       JOIN assignment_member_cells ac ON ac.assignment_id = a.assignment_id
       ${unitJoin}
       -- The line in the assignment's own lane, and the assignee's one vote on
       -- it there (cell_validators keys one row per person per cell per lane).
       LEFT JOIN cells t ON t.project_id = ac.project_id AND t.file_id = ac.file_id
                        AND t.cell_id = ac.cell_id AND t.side = 'target'
                        AND t.lane_id = a.lane_id
       LEFT JOIN cell_validators v ON v.project_id = ac.project_id AND v.file_id = ac.file_id
                                  AND v.cell_id = ac.cell_id AND v.lane_id = a.lane_id
                                  AND v.username = u.username
       -- The line's takes in that lane, each with the assignee's vote on it if
       -- any. A vote on a removed or replaced take is still a vote they cast,
       -- which is what rule 4 asks about, so deleted takes stay in the scan
       -- and only the "recorded"/"approved" terms require a live one.
       LEFT JOIN LATERAL (
         SELECT COALESCE(BOOL_OR(${LIVE_DUB}), false) AS recorded,
                COALESCE(BOOL_OR(${LIVE_DUB} AND ${takeSoundsOnItsTrackSql("ca")}
                                 AND mv.username IS NULL), false) AS unapproved,
                COALESCE(BOOL_OR(${LIVE_DUB} AND ${takeSoundsOnItsTrackSql("ca")}
                                 AND ca.created_by = u.username), false) AS own_take,
                COALESCE(BOOL_OR(mv.username IS NOT NULL), false) AS voted
           FROM cell_audio ca
           LEFT JOIN cell_audio_validators mv
             ON mv.project_id = ca.project_id AND mv.file_id = ca.file_id
            AND mv.cell_id = ca.cell_id AND mv.audio_id = ca.audio_id
            AND mv.username = u.username
          WHERE ca.project_id = ac.project_id AND ca.file_id = ac.file_id
            AND ca.cell_id = ac.cell_id
            AND ${audioLaneTagSql("ca")} = COALESCE(ln.legacy_tag, '')
       ) au ON true
       CROSS JOIN LATERAL (
         SELECT (v.event_id IS NOT NULL AND v.event_id = t.event_id) AS text_mine,
                TRIM(COALESCE(t.value, '')) <> '' AS translated,
                v.event_id IS NOT NULL AS text_voted,
                au.recorded AS recorded,
                (au.recorded AND NOT au.unapproved) AS audio_mine,
                au.voted AS audio_voted
       ) y
       CROSS JOIN LATERAL (
         SELECT y.*,
                (NOT y.text_mine AND ${SELF_VALIDATION_OFF_SQL}
                  AND t.last_editor IS NOT NULL AND t.last_editor = u.username) AS text_cant,
                (NOT y.audio_mine AND ${SELF_VALIDATION_AUDIO_OFF_SQL} AND au.own_take) AS audio_cant
       ) x
      WHERE a.assignment_id IN (${assignmentIds.map(() => "?").join(", ")})
        AND a.kind = 'validate'
        -- AQU-1083 / AQU-1493: headings leave the count when the project (or
        -- its org) does not count them — the same policy every other
        -- assignment figure applies, read the same way.
        AND NOT (COALESCE((
              SELECT COALESCE(ps2.count_structural, os.count_structural) = 'false'
                FROM projects p
                LEFT JOIN project_settings ps2 ON ps2.project_id = p.id
                LEFT JOIN org_settings os ON os.org_id = p.org_id
               WHERE p.id = a.project_id), false)
             AND COALESCE(ac.type, '') IN ('heading', 'paratext'))
        ${unitPredicate}
      GROUP BY a.assignment_id`,
  )
    // Positional, in statement order: the id list, then the unit's file and
    // section key when a unit was asked for.
    .bind(...assignmentIds, ...unitBinds)
    .all<{
      assignment_id: string
      text_total: number
      text_validated: number
      text_waiting: number
      text_changed: number
      audio_total: number
      audio_validated: number
      audio_waiting: number
      audio_changed: number
    }>()

  for (const r of rows.results ?? []) {
    out.set(r.assignment_id, {
      text: {
        total: Number(r.text_total),
        validated: Number(r.text_validated),
        waiting: Number(r.text_waiting),
        changed: Number(r.text_changed),
      },
      audio: {
        total: Number(r.audio_total),
        validated: Number(r.audio_validated),
        waiting: Number(r.audio_waiting),
        changed: Number(r.audio_changed),
      },
    })
  }
  return out
}
