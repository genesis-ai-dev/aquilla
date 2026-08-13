// Pure handler for AuthorizedEvent<'file.track.set'>.
//
// Applies ONE timeline track's presentation overrides — a rename, a reorder,
// a group membership, or the whole record of a user-added track. The deltas
// live in files.meta JSON under `trackOverrides`, keyed by track id, beside
// coreMediaUrl/timingMode. A null patch removes the entry; a null field
// inside a patch clears that single override. Writes the canonical event row
// PLUS a files UPDATE (shared SQL with the rebuild projection —
// buildFileTrackSetStmt). Non-chain-mutating; mirrors handleFileTimingSet.
// Maintainer floor (role-policy) — track structure is file structure.
//
// The validation below is strict on purpose, and asymmetric with the rebuild
// projection case, which validates nothing: this handler is the ONLY place a
// new shape can enter meta, while rebuild replays history that was already
// accepted and must never start rejecting it. Stage 1 ships the kind dormant,
// so the very first writes to reach here will be stage 3's — the allow-list
// is what keeps that future UI from quietly widening the stored shape.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import { buildEventInsertStmt } from '../event-insert'
import { buildFileTrackSetStmt } from '../event-projection'
import type { DispatchResult } from './types'

/**
 * Track ids and group ids. Wide enough for the four well-known literals and
 * for generated uuids, capped at 64 because the id becomes a JSON key inside
 * files.meta.trackOverrides — an unbounded id is an unbounded meta blob.
 */
const TRACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The four TrackKind values. They double as the four RESERVED track ids —
 * a default track's id IS its kind string — hence the second name below:
 * the two are the same set today but gate different fields, and only the
 * alias reads correctly at its call site. Reserved rather than "default"
 * because which of them a given file actually draws depends on the file:
 * a dubbing file has no target-subtitles row, but the id stays spoken for.
 *
 * Renamed in stage 2 ('subtitles' -> 'source-subtitles', 'target-subtitles'
 * added) while the kind was still DORMANT: no event has ever carried the old
 * spellings, so there is no stored payload to migrate. That window is now
 * spent.
 *
 * HAND-MIRRORED with DEFAULT_TRACK_IDS in src/lib/timeline/tracks.ts. The
 * client and this worker share no code, so the two lists are kept in step by
 * hand and must be edited together. Drift is not cosmetic: a kind the client
 * will happily persist but this allow-list rejects makes every retry of that
 * event fail identically, which wedges the client's outbox behind it.
 */
const TRACK_KINDS = new Set(['source-subtitles', 'source-audio', 'target-subtitles', 'target-audio'])
const DEFAULT_TRACK_IDS = TRACK_KINDS

const PATCH_KEYS = new Set(['kind', 'name', 'order', 'groupId'])

const MAX_TRACK_NAME_LENGTH = 120

export function handleFileTrackSet(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.track.set'>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  if (!event.fileId) {
    throw new Error(`file.track.set event ${event.id} is missing fileId`)
  }

  const { trackId, patch } = event.payload
  if (typeof trackId !== 'string' || !TRACK_ID_PATTERN.test(trackId)) {
    throw new Error(`file.track.set event ${event.id} carries an unusable trackId: ${String(trackId)}`)
  }

  if (patch !== null) {
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error(`file.track.set event ${event.id} carries a non-object patch: ${String(patch)}`)
    }
    const keys = Object.keys(patch)
    // An empty patch would store `{}` under the track id and say nothing —
    // reject it so meta only ever grows entries that mean something (and so
    // "reset this track" stays spelled exactly one way: patch: null).
    if (keys.length === 0) {
      throw new Error(`file.track.set event ${event.id} carries an empty patch`)
    }
    for (const key of keys) {
      // The allow-list is also what keeps the patch FLAT, which the
      // projection's recursive jsonb_strip_nulls depends on.
      if (!PATCH_KEYS.has(key)) {
        throw new Error(`file.track.set event ${event.id} carries an unknown patch key: ${key}`)
      }
    }

    if ('kind' in patch) {
      // A track's kind is its identity, not a preference: there is no null
      // form (nothing to fall back to), and on a default track the kind is
      // derived from the id, so an override there could only ever be a lie.
      const { kind } = patch
      if (typeof kind !== 'string' || !TRACK_KINDS.has(kind)) {
        throw new Error(`file.track.set event ${event.id} carries an unknown track kind: ${String(kind)}`)
      }
      if (DEFAULT_TRACK_IDS.has(trackId)) {
        throw new Error(`file.track.set event ${event.id} sets kind on default track ${trackId}`)
      }
    }

    if ('name' in patch && patch.name !== null) {
      // Clearing a rename is `name: null`. "" (or all-whitespace) would
      // persist an invisible label that every reader downstream would then
      // have to defend against.
      const { name } = patch
      if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_TRACK_NAME_LENGTH) {
        throw new Error(`file.track.set event ${event.id} carries an unusable track name: ${JSON.stringify(name)}`)
      }
    }

    if ('order' in patch && patch.order !== null) {
      // NEGATIVE and FRACTIONAL orders are legal and must stay legal: order
      // is a sort key, and stage 3 inserts a track between two others (0.5)
      // or ahead of the first one (-1) without rewriting its neighbours.
      // Only non-numbers, NaN and the infinities are rejected.
      const { order } = patch
      if (typeof order !== 'number' || !Number.isFinite(order)) {
        throw new Error(`file.track.set event ${event.id} carries a non-finite track order: ${String(order)}`)
      }
    }

    if ('groupId' in patch && patch.groupId !== null) {
      const { groupId } = patch
      if (typeof groupId !== 'string' || !TRACK_ID_PATTERN.test(groupId)) {
        throw new Error(`file.track.set event ${event.id} carries an unusable groupId: ${String(groupId)}`)
      }
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
  })

  const fileUpdate = buildFileTrackSetStmt(
    db,
    event.projectId,
    event.fileId,
    event.id,
    trackId,
    patch,
  )

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
    stmts: [eventInsert, fileUpdate],
    eventFrame,
    dirtyTables: ['events', 'files'] as ProjectionTable[],
  }
}
