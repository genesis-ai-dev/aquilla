// Shared handler implementation for every cell-level event kind.
//
// One function (handleCellEvent) handles all of:
//   - source.cell.create / target.cell.create
//   - source.cell.commit / target.cell.commit
//   - source.cell.delete / target.cell.delete
//   - source.cell.reorder / target.cell.reorder
//   - cell.validate / cell.unvalidate
//
// The distinction between source and target is enforced upstream in
// role-policy.ts (source.* requires PROJECT_LEAD+; target.* requires
// CONTRIBUTOR+). At this point the event has been authorized, and the
// only thing the handler does is:
//   1. Emit the canonical `events` row INSERT.
//   2. Emit the projection statements via buildEventProjectionStmts.
//   3. Build the realtime frame for broadcast.
//
// The AD-2 first-child-of-parent guard runs in route.ts BEFORE this
// handler — by the time we get here, the caller has decided the event
// is a winning chain head (or a sibling that should still land in
// `events` without advancing the projection).

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { EventKind } from '../types'
import { buildEventProjectionStmts, type PersistedEvent } from '../event-projection'
import type { DispatchResult } from './types'

export interface HandleCellEventOptions {
  /**
   * When false, the projection statements are SKIPPED — the caller has
   * decided this event is a stale chain sibling (AD-2 lost the first-
   * child race) and only the `events` row should be persisted.
   */
  updateProjection: boolean
}

/** Cell-level kinds that this handler accepts. */
export type CellEventKind = Exclude<EventKind, 'file.create'>

function projectionTablesFor(touches: readonly ProjectionTable[]): ProjectionTable[] {
  // Always include `events` so dirty-table broadcasts invalidate the
  // event-log query caches.
  const set = new Set<ProjectionTable>(['events'])
  for (const t of touches) set.add(t)
  return [...set]
}

export function handleCellEvent(
  db: D1Database,
  authed: AuthorizedEvent<CellEventKind>,
  serverTs: number,
  opts: HandleCellEventOptions,
): DispatchResult {
  const { event, claims } = authed

  // server_seq is derived atomically inside the INSERT — see the
  // EVENT_INSERT_SQL comment in events/import-route.ts for the race-safety
  // argument.
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
  let projectionTouches: readonly ProjectionTable[] = []

  if (opts.updateProjection) {
    const persisted: PersistedEvent = {
      id: event.id,
      schemaVersion: event.schemaVersion,
      projectId: event.projectId,
      fileId: event.fileId ?? null,
      cellId: event.cellId ?? null,
      parentId: event.parentId ?? null,
      kind: event.kind,
      author: claims.username,
      payload: event.payload,
      clientTs: event.clientTs,
      serverTs,
    }
    projectionTouches = buildEventProjectionStmts(db, persisted, stmts)
  }

  const eventFrame: Extract<RealtimeMessage, { t: 'event' }> = {
    v: 1,
    t: 'event',
    id: event.id,
    kind: event.kind,
    project: event.projectId,
    file: event.fileId,
    cell: event.cellId,
    ts: serverTs,
  }

  return {
    stmts,
    eventFrame,
    dirtyTables: projectionTablesFor(projectionTouches),
  }
}
