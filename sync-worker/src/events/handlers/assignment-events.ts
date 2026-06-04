// Handler for the assignment.* event family (Phase C — manager work assignment).
//
// Assignments are PROJECT-level and non-chain-mutating: they don't move any
// cell's event_id chain head. Like comment.*, the event carries a fileId on the
// envelope (auth/routing — the manager emits through a file-scoped sync token)
// but the assigned scope is project-level and lives in the payload.
//
// Each event writes the canonical events row (history/audit) and then mutates
// the `assignments` / `assignment_cells` projection tables:
//   - assignment.create  : INSERT the assignments row, resolve the book/chapter
//                           scope into assignment_cells from the live `cells`
//                           projection, then set cells_total.
//   - assignment.reassign : UPDATE assignee_user_id.
//   - assignment.unassign : set unassigned_at (soft close; row kept for audit).
//
// Progress (cells_done) is NOT stored — it's derived on read (AS2) by joining
// assignment_cells -> cells WHERE validated = 1, so slice 1 never touches the
// hot cell.commit path.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { EventKind, EventPayloads } from '../types'
import type { DispatchResult } from './types'

export type AssignmentEventKind = Extract<
  EventKind,
  'assignment.create' | 'assignment.reassign' | 'assignment.unassign'
>

export function handleAssignmentEvent(
  db: D1Database,
  authed: AuthorizedEvent<AssignmentEventKind>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  // Canonical events row. server_seq is derived atomically inside the INSERT —
  // same shape as comment-events.ts / cell-events.ts.
  const eventInsert = db
    .prepare(
      `INSERT INTO events (
        id, schema_version, project_id, file_id, cell_id, parent_id, kind,
        author, payload, client_ts, server_ts, server_seq
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + 1
        ON CONFLICT DO NOTHING`,
    )
    .bind(
      event.id,
      event.schemaVersion,
      event.projectId,
      event.fileId ?? null,
      event.cellId ?? null,
      event.parentId ?? null,
      event.kind,
      claims.username,
      JSON.stringify(event.payload),
      event.clientTs,
      serverTs,
      event.projectId,
    )

  const stmts: D1PreparedStatement[] = [eventInsert]
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
            cells_total, deadline, note, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`,
        )
        .bind(
          p.assignmentId,
          event.projectId,
          p.assigneeUserId,
          p.scopeKind,
          p.scopeLabel,
          p.deadline ?? null,
          p.note ?? null,
          claims.userId,
          serverTs,
        ),
    )

    // 2. Resolve each scope entry -> source cells from the live cells
    //    projection. One INSERT...SELECT per entry. The cells projection
    //    hard-deletes on *.cell.delete (no deleted_at column), so a plain
    //    side='source' filter is the live set. Chapter scope narrows by
    //    canonical_ref (e.g. "GEN 1" -> LIKE 'GEN 1:%', which excludes
    //    "GEN 11:1" because the ':' anchors the chapter boundary).
    for (const entry of p.scope) {
      if (entry.chapter) {
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
    stmts.push(
      db
        .prepare(
          `UPDATE assignments SET assignee_user_id = ?
           WHERE assignment_id = ? AND project_id = ?`,
        )
        .bind(p.assigneeUserId, p.assignmentId, event.projectId),
    )
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
