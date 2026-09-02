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
//
// Every one of those refusals is RETURNED, never thrown: see DispatchOutcome
// in ./types for why a throw here would 500 the whole POST and wedge the
// client's outbox on the one bad event.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import { buildEventInsertStmt } from '../event-insert'
import { buildFileTrackSetStmt } from '../event-projection'
import { DEFAULT_TRACK_IDS, trackPatchRequiresExisting } from '../track-editing-authority'
import type { DispatchOutcome } from './types'

/**
 * Track ids and group ids. Wide enough for the four well-known literals and
 * for generated uuids, capped at 64 because the id becomes a JSON key inside
 * files.meta.trackOverrides — an unbounded id is an unbounded meta blob.
 */
const TRACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Every TrackKind a patch may name.
 *
 * Renamed in stage 2 ('subtitles' -> 'source-subtitles', 'target-subtitles'
 * added) while the kind was still DORMANT: no event has ever carried the old
 * spellings, so there is no stored payload to migrate. That window is now
 * spent.
 *
 * HAND-MIRRORED with TRACK_KIND_LABELS in src/lib/timeline/tracks.ts. The
 * client and this worker share no code, so the two lists are kept in step by
 * hand and must be edited together. Drift is not cosmetic: a kind the client
 * will happily persist but this allow-list rejects makes every retry of that
 * event fail identically, which wedges the client's outbox behind it.
 */
const TRACK_KINDS = new Set([
  'source-subtitles',
  'source-audio',
  'target-subtitles',
  'target-audio',
  'folder',
  'audio',
])


/**
 * The STORAGE SLOT names the default dub row owns, which are therefore not
 * available as track ids. (2026-08-27)
 *
 * A track's id IS its storage slot (`slotForTrack` returns it verbatim for
 * anything that is not a derived row), so a track created as `recording` or
 * `generatedVoice` addresses the same `cell_audio` slot as the default Target
 * audio row. Nothing downstream catches it — the projection's sibling-deselect
 * is per (cell, slot), so selecting on one row deselects on the other; and
 * `trackIdForSlot` maps both names back to `target-audio`, so the added
 * track's takes are attributed to the default row in the Recording tab and
 * filed under the wrong folder on export.
 *
 * The client comment claimed this could not happen because ids are uuidv7 and
 * this pattern "would not accept a camel-case word". Both halves are about ids
 * THIS client mints, and the second is simply wrong: TRACK_ID_PATTERN is
 * `/^[A-Za-z0-9_-]{1,64}$/`, which accepts both names.
 *
 * Separate from DEFAULT_TRACK_IDS because these reserve a SLOT, not a row:
 * they are not track ids anyone may set a kind on, and they never were.
 * HAND-MIRRORED with RECORDING_SLOT / GENERATED_VOICE_SLOT in
 * src/lib/timeline/track-slots.ts.
 */
const RESERVED_SLOT_IDS = new Set(['recording', 'generatedVoice'])

const PATCH_KEYS = new Set(['kind', 'name', 'order', 'groupId', 'color', 'sourceTrackId'])

/**
 * A palette ID, and validated as a SHAPE rather than against a list of the ids
 * this build knows.
 *
 * That is the whole point. The palette lives in the client
 * (src/lib/timeline/track-colors.ts) because what an id looks like is a
 * rendering decision, and a newer client will ship ids this worker has never
 * heard of. Enumerating them here would make every palette addition a
 * coordinated worker deploy, and — worse — would reject writes from clients
 * that are merely NEWER than the worker, which is the normal state of affairs
 * during a rollout. An old client reading an id it cannot name simply falls
 * back to the default pair; nothing is lost either way.
 */
const TRACK_COLOR_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

const MAX_TRACK_NAME_LENGTH = 120

export function handleFileTrackSet(
  db: AquillaDb,
  authed: AuthorizedEvent<'file.track.set'>,
  serverTs: number,
  /** Pre-allocated server_seq for this event (AQU-1005: allocation happens
   *  once per request via allocateSeqRange, outside the write transaction). */
  serverSeq: number,
): DispatchOutcome {
  const { event, claims } = authed

  if (!event.fileId) {
    return {
      ok: false,
      status: 400,
      reason: `file.track.set event ${event.id} is missing fileId`,
    }
  }

  const { trackId, patch } = event.payload
  if (typeof trackId !== 'string' || !TRACK_ID_PATTERN.test(trackId)) {
    return {
      ok: false,
      status: 400,
      reason: `file.track.set event ${event.id} carries an unusable trackId: ${String(trackId)}`,
    }
  }
  if (RESERVED_SLOT_IDS.has(trackId)) {
    return {
      ok: false,
      status: 400,
      reason: `file.track.set event ${event.id} uses a reserved storage slot as a trackId: ${trackId}`,
    }
  }

  if (patch !== null) {
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      return {
        ok: false,
        status: 400,
        reason: `file.track.set event ${event.id} carries a non-object patch: ${String(patch)}`,
      }
    }
    const keys = Object.keys(patch)
    // An empty patch would store `{}` under the track id and say nothing —
    // reject it so meta only ever grows entries that mean something (and so
    // "reset this track" stays spelled exactly one way: patch: null).
    if (keys.length === 0) {
      return {
        ok: false,
        status: 400,
        reason: `file.track.set event ${event.id} carries an empty patch`,
      }
    }
    for (const key of keys) {
      // The allow-list is also what keeps the patch FLAT, which the
      // projection's recursive jsonb_strip_nulls depends on.
      if (!PATCH_KEYS.has(key)) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} carries an unknown patch key: ${key}`,
        }
      }
    }

    if ('kind' in patch) {
      // A track's kind is its identity, not a preference: there is no null
      // form (nothing to fall back to), and on a default track the kind is
      // derived from the id, so an override there could only ever be a lie.
      const { kind } = patch
      if (typeof kind !== 'string' || !TRACK_KINDS.has(kind)) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} carries an unknown track kind: ${String(kind)}`,
        }
      }
      if (DEFAULT_TRACK_IDS.has(trackId)) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} sets kind on default track ${trackId}`,
        }
      }
    }

    if ('name' in patch && patch.name !== null) {
      // Clearing a rename is `name: null`. "" (or all-whitespace) would
      // persist an invisible label that every reader downstream would then
      // have to defend against.
      const { name } = patch
      if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_TRACK_NAME_LENGTH) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} carries an unusable track name: ${JSON.stringify(name)}`,
        }
      }
    }

    if ('order' in patch && patch.order !== null) {
      // NEGATIVE and FRACTIONAL orders are legal and must stay legal: order
      // is a sort key, and stage 3 inserts a track between two others (0.5)
      // or ahead of the first one (-1) without rewriting its neighbours.
      // Only non-numbers, NaN and the infinities are rejected.
      const { order } = patch
      if (typeof order !== 'number' || !Number.isFinite(order)) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} carries a non-finite track order: ${String(order)}`,
        }
      }
    }

    if ('groupId' in patch && patch.groupId !== null) {
      const { groupId } = patch
      if (typeof groupId !== 'string' || !TRACK_ID_PATTERN.test(groupId)) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} carries an unusable groupId: ${String(groupId)}`,
        }
      }
      // A track cannot be inside itself. Every other cycle — a 2-cycle, a
      // folder nested in a folder — is prevented by construction on the client
      // (buildTrackRows never reads a folder's own groupId), but this one is
      // cheap to refuse outright and refusing it keeps the stored data honest
      // for readers that do not share that rule.
      if (groupId === trackId) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} puts track ${trackId} inside itself`,
        }
      }
    }

    if ('color' in patch && patch.color !== null) {
      const { color } = patch
      if (typeof color !== 'string' || !TRACK_COLOR_PATTERN.test(color)) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} carries an unusable track color: ${String(color)}`,
        }
      }
    }

    if ('sourceTrackId' in patch && patch.sourceTrackId !== null) {
      // What an added track's chips line up against. Refused on a reserved id
      // for exactly the reason `kind` is: a derived row's alignment comes from
      // the file's own cells, so an override there could only be a lie.
      const { sourceTrackId } = patch
      if (typeof sourceTrackId !== 'string' || !TRACK_ID_PATTERN.test(sourceTrackId)) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} carries an unusable sourceTrackId: ${String(sourceTrackId)}`,
        }
      }
      if (sourceTrackId === trackId) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} aligns track ${trackId} to itself`,
        }
      }
      if (DEFAULT_TRACK_IDS.has(trackId)) {
        return {
          ok: false,
          status: 400,
          reason: `file.track.set event ${event.id} sets sourceTrackId on default track ${trackId}`,
        }
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
    serverSeq,
  })

  const fileUpdate = buildFileTrackSetStmt(
    db,
    event.projectId,
    event.fileId,
    event.id,
    trackId,
    patch,
    // A patch that cannot create a track must find one. See
    // `trackPatchRequiresExisting` — this is what stops a bare `{order}` or
    // `{name}` for an unknown id merging a kind-less entry into files.meta
    // that nothing can render and only the gated delete could remove.
    trackPatchRequiresExisting(trackId, patch),
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
    ok: true,
    result: {
      stmts: [eventInsert, fileUpdate],
      eventFrame,
      dirtyTables: ['events', 'files'] as ProjectionTable[],
    },
  }
}
