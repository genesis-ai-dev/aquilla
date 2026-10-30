// Pure handlers for AuthorizedEvent<'file.milestone.set' | 'file.milestone.remove'>.
//
// A hand-set milestone (AQU-2308) is a named start→end range of cells in one
// file, stored as its OWN record in `file_milestones` — not a label on a cell
// and not in the cell's import envelope, which a re-import replaces wholesale.
//
// Both kinds are file-scoped and non-chain-mutating: no parentId, and the only
// table either one touches besides `events` is `file_milestones`. That is what
// makes setting a division free — no cell's head advances, so no lane's
// translation goes stale and no "source changed" marker appears anywhere.
// Maintainer floor (role-policy), the file.track.set rationale: a division
// relayouts the navigator for every collaborator who opens the file.
//
// Every refusal below is RETURNED, never thrown — see DispatchOutcome in
// ./types. A throw here 500s the whole POST, and the client reads 5xx as
// transient and retries the identical batch forever, so one malformed event
// would wedge the outbox permanently.
//
// What is NOT checked here, deliberately: overlap with another milestone, and
// crossing a division the file supplied. Both need the file's DERIVED
// divisions, which are computed in the client from cell metadata and refs
// (src/lib/milestone-navigation.ts) and are not available to this worker. The
// dialog refuses both before anything is written, and the navigator's
// derivation resolves any that reach the store by another route under one
// total rule — earliest start wins, the overlapping one is skipped — so the
// navigator cannot be taken down by a record this handler let through.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import { buildEventInsertStmt } from '../event-insert'
import {
  buildFileMilestoneRemoveStmt,
  buildFileMilestoneSetStmt,
} from '../event-projection'
import {
  isValidMilestoneId,
  normalizeMilestoneName,
} from '../../../../db/shared/file-milestones'
import type { DispatchOutcome, DispatchResult } from './types'

function frameFor(
  event: { id: string; kind: string; projectId: string; fileId: string },
  serverTs: number,
): Extract<RealtimeMessage, { t: 'event' }> {
  return {
    v: 1,
    t: 'event',
    id: event.id,
    kind: event.kind as Extract<RealtimeMessage, { t: 'event' }>['kind'],
    project: event.projectId,
    file: event.fileId,
    ts: serverTs,
  }
}

export function handleFileMilestoneSet(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.milestone.set'>,
  serverTs: number,
  serverSeq: number,
): DispatchOutcome {
  const { event, claims } = authed

  if (!event.fileId) {
    return { ok: false, status: 400, reason: 'file.milestone.set is missing fileId' }
  }
  const { milestoneId, startCellId, endCellId } = event.payload
  if (!isValidMilestoneId(milestoneId)) {
    return { ok: false, status: 400, reason: 'file.milestone.set carries an unusable milestoneId' }
  }
  // The SHARED rule, not a second copy of it: the dialog calls the same
  // function, so "what counts as a name" cannot drift between the two.
  const name = normalizeMilestoneName(event.payload.name)
  if (name === null) {
    return {
      ok: false,
      status: 400,
      reason: 'a milestone name cannot be blank or whitespace-only',
    }
  }
  if (typeof startCellId !== 'string' || !startCellId
    || typeof endCellId !== 'string' || !endCellId) {
    return {
      ok: false,
      status: 400,
      reason: 'file.milestone.set needs both a start cell and an end cell',
    }
  }

  const eventInsert = buildEventInsertStmt(db, {
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId,
    cellId: null,
    parentId: event.parentId ?? null,
    kind: event.kind,
    author: claims.username,
    payloadJson: JSON.stringify(event.payload),
    clientTs: event.clientTs,
    serverTs,
    serverSeq,
  })

  const upsert = buildFileMilestoneSetStmt(db, event.projectId, event.fileId, event.id, {
    milestoneId,
    name,
    startCellId,
    endCellId,
    author: claims.username,
    serverTs,
    serverSeq,
  })

  const result: DispatchResult = {
    stmts: [eventInsert, upsert],
    eventFrame: frameFor({ ...event, fileId: event.fileId }, serverTs),
    dirtyTables: ['events', 'file_milestones'] as ProjectionTable[],
  }
  return { ok: true, result }
}

export function handleFileMilestoneRemove(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.milestone.remove'>,
  serverTs: number,
  serverSeq: number,
): DispatchOutcome {
  const { event, claims } = authed

  if (!event.fileId) {
    return { ok: false, status: 400, reason: 'file.milestone.remove is missing fileId' }
  }
  const { milestoneId } = event.payload
  if (!isValidMilestoneId(milestoneId)) {
    return { ok: false, status: 400, reason: 'file.milestone.remove carries an unusable milestoneId' }
  }

  const eventInsert = buildEventInsertStmt(db, {
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId,
    cellId: null,
    parentId: event.parentId ?? null,
    kind: event.kind,
    author: claims.username,
    payloadJson: JSON.stringify(event.payload),
    clientTs: event.clientTs,
    serverTs,
    serverSeq,
  })

  // DELETE, not a tombstone column: a removed division leaves nothing a reader
  // could want. The statement is a no-op when the row is already gone, which
  // is what makes a retried outbox entry harmless.
  const remove = buildFileMilestoneRemoveStmt(
    db,
    event.projectId,
    event.fileId,
    milestoneId,
  )

  const result: DispatchResult = {
    stmts: [eventInsert, remove],
    eventFrame: frameFor({ ...event, fileId: event.fileId }, serverTs),
    dirtyTables: ['events', 'file_milestones'] as ProjectionTable[],
  }
  return { ok: true, result }
}
