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
//                           A book/chapter scope ALSO records the range itself
//                           in assignment_scopes, so the read side can
//                           re-resolve it and pick up lines added later
//                           (AQU-1629) — a resolved snapshot can only ever
//                           shrink, never grow.
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
    //    projection. One INSERT...SELECT per entry, or per chunk for a
    //    'cells' scope. The cells projection hard-deletes on *.cell.delete
    //    (no deleted_at column), so a plain side='source' filter is the live
    //    set. Chapter scope narrows by canonical_ref (e.g. "GEN 1" -> LIKE
    //    'GEN 1:%', which excludes "GEN 11:1" because the ':' anchors the
    //    chapter boundary).
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
        stmts.push(
          db
            .prepare(
              `INSERT INTO assignment_cells (assignment_id, file_id, cell_id)
               SELECT ?, file_id, cell_id FROM cells
               WHERE project_id = ? AND file_id = ? AND side = 'source' AND canonical_ref LIKE ?
               ON CONFLICT DO NOTHING`,
            )
            .bind(p.assignmentId, event.projectId, entry.fileId, `${entry.chapter}:%`),
        )
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

      // AQU-1629: record the RANGE, not only what it resolved to. The rows
      // above are a snapshot of the cells that existed at this instant, and
      // nothing re-resolved them, so a line added to the chapter or file
      // afterwards never joined the assignment — the assignee's progress could
      // read done over a chapter that still had open work. `assignment_scopes`
      // lets the read side re-resolve the scope against live `cells` on every
      // read (view `assignment_member_cells`, migration 0129).
      //
      // Deliberately NOT written for a 'cells' entry: an explicit selection is
      // exactly the lines the manager picked, and must not silently acquire
      // new ones. The branch is the same `entry.cellIds` test as above, so a
      // scope kind and its entries can never disagree about which it is.
      if (!entry.cellIds) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO assignment_scopes (assignment_id, file_id, chapter)
               VALUES (?, ?, ?)
               ON CONFLICT DO NOTHING`,
            )
            // '' = the whole file (a 'books' scope); see the column comment.
            .bind(p.assignmentId, entry.fileId, entry.chapter ?? ''),
        )
      }
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
