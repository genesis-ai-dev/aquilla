// Handler for the assignment.* event family (Phase C — manager work assignment).
//
// Assignments are PROJECT-level and non-chain-mutating: they don't move any
// cell's event_id chain head. Like comment.*, the event carries a fileId on the
// envelope (auth/routing — the manager emits through a file-scoped sync token)
// but the assigned scope is project-level and lives in the payload.
//
// Each event writes the canonical events row (history/audit) and then mutates
// the `assignments` / `assignment_cells` projection tables:
//   - assignment.create  : INSERT the assignments row, resolve the
//                           book/chapter/cell scope into assignment_cells from
//                           the live `cells` projection, then set cells_total.
//                           A chapter is resolved with the plan board's own
//                           chapter keys (AQU-1493, db/shared/plan-keys.ts),
//                           so a person given "JON 2" gets the chapter's
//                           headings and the lines already added in it,
//                           exactly the cells the board counts in JON 2.
//   - assignment.reassign : UPDATE assignee_user_id.
//   - assignment.unassign : set unassigned_at (soft close; row kept for audit).
//
// Progress (cells_done) is NOT stored — it's derived on read (AS2) by joining
// assignment_cells -> cells WHERE validated = 1, so slice 1 never touches the
// hot cell.commit path.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { EventKind, EventPayloads } from '../types'
import { buildEventInsertStmt } from '../event-insert'
import { laneIdResolveBinds, laneIdResolveSql } from '../lane-id-sql'
import {
  inheritedKeysSql,
  oneScriptureFileSql,
  unitSectionKeyExpr,
} from '../../../../db/shared/plan-keys'
import type { DispatchResult } from './types'

/** Cell ids per INSERT for a 'cells' scope — keeps one statement's parameter
 *  count bounded when a manager selects a whole chapter by hand. */
const CELL_SCOPE_CHUNK = 500

export type AssignmentEventKind = Extract<
  EventKind,
  'assignment.create' | 'assignment.reassign' | 'assignment.unassign'
>

export function handleAssignmentEvent(
  db: AquillaDb,
  authed: AuthorizedEvent<AssignmentEventKind>,
  serverTs: number,
  /** Pre-allocated server_seq for this event (AQU-1005: allocation happens
   *  once per request via allocateSeqRange, outside the write transaction). */
  serverSeq: number,
): DispatchResult {
  const { event, claims } = authed

  // Canonical events row.
  const eventInsert = buildEventInsertStmt(db, {
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId ?? null,
    cellId: event.cellId ?? null,
    parentId: event.parentId ?? null,
    kind: event.kind,
    author: claims.username,
    payloadJson: JSON.stringify(event.payload),
    clientTs: event.clientTs,
    serverTs,
    serverSeq,
  })

  const stmts: AquillaStatement[] = [eventInsert]
  const dirtyTables: ProjectionTable[] = ['events']

  if (event.kind === 'assignment.create') {
    const p = event.payload as EventPayloads['assignment.create']

    // 1. Insert the assignment row. cells_total starts at 0 and is filled by
    //    the COUNT update below (after assignment_cells is populated).
    stmts.push(
      db
        .prepare(
          `INSERT INTO assignments (
            assignment_id, project_id, assignee_user_id, scope_kind, scope_label,
            target_lang, lane_id, cells_total, deadline, note, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ${laneIdResolveSql('target')}, 0, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`,
        )
        .bind(
          p.assignmentId,
          event.projectId,
          p.assigneeUserId,
          p.scopeKind,
          p.scopeLabel,
          // AQU-538 (§3.5): '' is the default lane (absent/omitted on the wire).
          p.targetLang ?? '',
          ...laneIdResolveBinds('target', event.projectId, p.targetLang ?? ''),
          p.deadline ?? null,
          p.note ?? null,
          claims.userId,
          serverTs,
        ),
    )

    // 2. Resolve each scope entry -> source cells from the live cells
    //    projection. The cells projection hard-deletes on *.cell.delete (no
    //    deleted_at column), so a plain side='source' filter is the live set.
    //    A whole-file entry is one INSERT...SELECT of every source cell; a
    //    'cells' entry is one per chunk of ids.
    //
    //    AQU-1493: a chapter entry takes the cells the plan board counts in
    //    that chapter, by the board's own key (`unitSectionKeyExpr`): a cell's
    //    chapter from its reference, or for a line with no reference the
    //    chapter `inheritedKeysSql` gives it. Matching on `canonical_ref LIKE
    //    'JON 2:%'` alone missed every line added in the editor (the walk's
    //    FAIL: Carol's JON 2 row read "Nothing left" while chapter 2 still had
    //    a blank added line) and would miss every heading of an imported
    //    Bible, which now counts in the chapter it opens. Equality on the key
    //    also keeps "GEN 1" out of "GEN 11" without the LIKE's colon trick.
    //
    //    The walk costs a pass over the file's unreferenced lines, so chapter
    //    entries are grouped by file and resolved in ONE statement per file:
    //    an assignment can pick 50 chapters of one book, and 50 walks inside
    //    the write transaction would be 50 times the work for the same keys.
    //    Chapters are expanded into placeholders rather than bound as an
    //    array, which the shim does not promise to pass through.
    //
    //    Resolution happens once, here: an assignment is a snapshot of what a
    //    person was given, so a line added later does not join it, and
    //    existing assignments are not rewritten. Rebuild skips assignment.*
    //    events, so replay never re-resolves an old one under this rule.
    const chaptersByFile = new Map<string, Set<string>>()
    for (const entry of p.scope) {
      if (entry.cellIds) {
        // AQU-1628: an explicit line set ('cells' scope — the editor's current
        // selection). Resolved against the live cells projection like every
        // other scope, so an id that no longer exists simply drops out and
        // cells_total below counts what was actually assigned. Chunked because
        // a selection can be larger than one statement's parameter budget.
        for (let i = 0; i < entry.cellIds.length; i += CELL_SCOPE_CHUNK) {
          const chunk = entry.cellIds.slice(i, i + CELL_SCOPE_CHUNK)
          if (chunk.length === 0) continue
          stmts.push(
            db
              .prepare(
                `INSERT INTO assignment_cells (assignment_id, file_id, cell_id)
                 SELECT ?, file_id, cell_id FROM cells
                 WHERE project_id = ? AND file_id = ? AND side = 'source'
                   AND cell_id IN (${chunk.map(() => '?').join(', ')})
                 ON CONFLICT DO NOTHING`,
              )
              .bind(p.assignmentId, event.projectId, entry.fileId, ...chunk),
          )
        }
      } else if (entry.chapter) {
        const chapters = chaptersByFile.get(entry.fileId) ?? new Set<string>()
        // Trimmed like the board's key: the picker offers the raw text before
        // the verse colon (getFileChapters), the board trims it.
        chapters.add(entry.chapter.trim())
        chaptersByFile.set(entry.fileId, chapters)
      } else {
        stmts.push(
          db
            .prepare(
              `INSERT INTO assignment_cells (assignment_id, file_id, cell_id)
               SELECT ?, file_id, cell_id FROM cells
               WHERE project_id = ? AND file_id = ? AND side = 'source'
               ON CONFLICT DO NOTHING`,
            )
            .bind(p.assignmentId, event.projectId, entry.fileId),
        )
      }
    }
    for (const [fileId, chapterSet] of chaptersByFile) {
      const chapters = [...chapterSet]
      stmts.push(
        db
          .prepare(
            `WITH inherited_keys AS (
               ${inheritedKeysSql(oneScriptureFileSql())}
             )
             INSERT INTO assignment_cells (assignment_id, file_id, cell_id)
             SELECT ?, c.file_id, c.cell_id
               FROM cells c
               LEFT JOIN inherited_keys ik ON ik.cell_id = c.cell_id
              WHERE c.project_id = ? AND c.file_id = ? AND c.side = 'source'
                AND ${unitSectionKeyExpr('c', 'ik')} IN (${chapters.map(() => '?').join(', ')})
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            event.projectId, fileId, // inherited_keys (oneScriptureFileSql)
            p.assignmentId, event.projectId, fileId,
            ...chapters,
          ),
      )
    }

    // 3. Stamp the resolved denominator.
    stmts.push(
      db
        .prepare(
          `UPDATE assignments SET cells_total =
             (SELECT COUNT(*) FROM assignment_cells WHERE assignment_id = ?)
           WHERE assignment_id = ?`,
        )
        .bind(p.assignmentId, p.assignmentId),
    )

    dirtyTables.push('assignments', 'assignment_cells')
  } else if (event.kind === 'assignment.reassign') {
    const p = event.payload as EventPayloads['assignment.reassign']
    // AQU-538 (§3.5): a plain reassign (no targetLang) only moves the assignee
    // and leaves the stored lane untouched; when the payload carries a lane,
    // re-pin it too (including to '' = default lane).
    if (p.targetLang !== undefined) {
      stmts.push(
        db
          .prepare(
            `UPDATE assignments SET assignee_user_id = ?, target_lang = ?,
                    lane_id = ${laneIdResolveSql('target')}
             WHERE assignment_id = ? AND project_id = ?`,
          )
          .bind(
            p.assigneeUserId,
            p.targetLang,
            ...laneIdResolveBinds('target', event.projectId, p.targetLang),
            p.assignmentId,
            event.projectId,
          ),
      )
    } else {
      stmts.push(
        db
          .prepare(
            `UPDATE assignments SET assignee_user_id = ?
             WHERE assignment_id = ? AND project_id = ?`,
          )
          .bind(p.assigneeUserId, p.assignmentId, event.projectId),
      )
    }
    dirtyTables.push('assignments')
  } else {
    // assignment.unassign — soft close, keep the row + its cells for audit.
    const p = event.payload as EventPayloads['assignment.unassign']
    stmts.push(
      db
        .prepare(
          `UPDATE assignments SET unassigned_at = ?
           WHERE assignment_id = ? AND project_id = ?`,
        )
        .bind(serverTs, p.assignmentId, event.projectId),
    )
    dirtyTables.push('assignments')
  }

  const eventFrame: Extract<RealtimeMessage, { t: 'event' }> = {
    v: 1,
    t: 'event',
    id: event.id,
    kind: event.kind,
    project: event.projectId,
    file: event.fileId,
    ts: serverTs,
  }

  return {
    stmts,
    eventFrame,
    dirtyTables,
  }
}
