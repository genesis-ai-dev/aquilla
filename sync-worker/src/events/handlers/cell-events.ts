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
// The AD-2 first-child-of-parent PRE-check runs in route.ts BEFORE this
// handler — it catches temporally separated siblings (a committed sibling
// already exists) and sets updateProjection=false. For IN-FLIGHT races the
// pre-check is a TOCTOU (audit RACE-2), so chain-mutating events also take
// an atomic chain_claims row here and their cells writes are gated on
// holding it (see chain-claims.ts). The route reads the claims back after
// commit to flag losers as stale in the response.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { EventKind } from '../types'
import {
  buildEventProjectionStmts,
  isChainArbitrated,
  type PersistedEvent,
} from '../event-projection'
import { buildChainClaimStmt, eventQualifiedParentKey, type ChainSlot } from '../chain-claims'
import { buildEventInsertStmt } from '../event-insert'
import type { DispatchResult } from './types'

export interface HandleCellEventOptions {
  /**
   * AQU-1005: pre-allocated server_seq for this event. Allocation happens
   * once per request via allocateSeqRange, OUTSIDE the write transaction, so
   * the per-project counter row lock is never held across the event batch.
   */
  serverSeq: number
  /**
   * When false, the projection statements are SKIPPED — the caller has
   * decided this event is a stale chain sibling (AD-2 lost the first-
   * child race) and only the `events` row should be persisted.
   */
  updateProjection: boolean
  /**
   * QW-10: skip the per-event file-counter recompute; the caller coalesces
   * one recompute per (file, batch) instead (route.ts appends it per chunk).
   * The affected file is reported back via DispatchResult.counterFile.
   */
  deferFileCounters?: boolean
  /**
   * AQU-279: project-level threshold for cells.validated.
   * Forwarded to buildEventProjectionStmts for cell.validate / cell.unvalidate.
   * Default 1 (N=1 projects: byte-identical behavior).
   */
  validationCount?: number
}

/** Cell-level kinds that this handler accepts. */
export type CellEventKind = Exclude<EventKind, 'file.create'>

/**
 * AQU-1093: audio events that change the per-unit audio ROLLUP.
 *
 * Audio projections only touch `cell_audio`, so before this they never
 * triggered a progress recompute — file/section/book audio counts would drift
 * the moment anyone recorded or approved a take, and only a full rebuild would
 * repair them.
 *
 * Deliberately not every `cell.audio.*` kind: rename, trim, place and measure
 * are frequent (one timeline drag emits a stream of them) and change no count.
 */
const AUDIO_ROLLUP_KINDS: ReadonlySet<string> = new Set([
  'cell.audio.attach',
  'cell.audio.select',
  'cell.audio.remove',
  'cell.audio.validate',
  'cell.audio.unvalidate',
])

function touchesAudioRollup(kind: string, touches: readonly ProjectionTable[]): boolean {
  return touches.includes('cell_audio') && AUDIO_ROLLUP_KINDS.has(kind)
}

function projectionTablesFor(touches: readonly ProjectionTable[]): ProjectionTable[] {
  // Always include `events` so dirty-table broadcasts invalidate the
  // event-log query caches.
  const set = new Set<ProjectionTable>(['events'])
  for (const t of touches) set.add(t)
  return [...set]
}

export function handleCellEvent(
  db: AquillaDb,
  authed: AuthorizedEvent<CellEventKind>,
  serverTs: number,
  opts: HandleCellEventOptions,
): DispatchResult {
  const { event, claims } = authed

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
    serverSeq: opts.serverSeq,
  })

  const stmts: AquillaStatement[] = [eventInsert]
  let projectionTouches: readonly ProjectionTable[] = []
  let counterFile: DispatchResult['counterFile']

  // Atomic AD-2 arbitration: chain-arbitrated events claim their chain slot in
  // the same transaction, and the projection's cells write is gated on the
  // claim — so an in-flight sibling race resolves to exactly one winner.
  // A parent-null cell delete is a tombstone, not a chain extension — it takes
  // no claim and projects ungated, matching rebuild's replay rule (AQU-931).
  let chainGate: ChainSlot | undefined
  if (
    opts.updateProjection &&
    isChainArbitrated(event.kind, event.parentId ?? null) &&
    event.fileId &&
    event.cellId
  ) {
    // The chain slot is side-qualified for source events and lane-qualified
    // for non-default target lanes. A translation pinned to a source head
    // must not prevent that source from being corrected later.
    chainGate = {
      projectId: event.projectId,
      fileId: event.fileId,
      cellId: event.cellId,
      parentKey: eventQualifiedParentKey(event.parentId, event.kind, event.payload),
    }
    stmts.push(buildChainClaimStmt(db, chainGate, event.id))
  }

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
    projectionTouches = buildEventProjectionStmts(db, persisted, stmts, {
      deferFileCounters: opts.deferFileCounters,
      chainGate,
      validationCount: opts.validationCount,
    })
    if (
      opts.deferFileCounters &&
      event.fileId &&
      (projectionTouches.includes('files') || touchesAudioRollup(event.kind, projectionTouches))
    ) {
      counterFile = { projectId: event.projectId, fileId: event.fileId }
    }
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
    chainSlot: chainGate,
    counterFile,
  }
}
