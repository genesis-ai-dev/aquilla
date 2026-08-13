// The timeline track contract. (AQU-646 stage 1)
//
// Until now a "track" was three hardcoded rows of JSX in TimelineEditor plus a
// hand-mirrored label gutter — there was no entity to rename, reorder or group,
// which is exactly what The Chosen's per-episode text/audio/character files
// need. This module is the single owner of that entity: the three defaults
// every file starts with, the deltas persisted against them, and the merge that
// turns the two into the list the editor draws.
//
// It imports NOTHING, deliberately. `FileReference` type-imports
// PersistedTrackOverrides from here, so a type-only import back the other way
// would close a cycle; `deriveTracksForFile` takes a structural parameter
// instead of `Pick<FileReference, …>`.
//
// WHAT IS PERSISTED IS A PER-TRACK DELTA, NEVER A LIST. `files.meta
// .trackOverrides` is a Record<trackId, patch> holding only the fields that
// differ from the derived default. The field is called `trackOverrides` and
// never `tracks` for precisely that reason: no reader should mistake it for the
// full set.
//
// UNKNOWN TRACK KINDS ARE DROPPED FROM THE MERGE OUTPUT, AND THAT IS SAFE ONLY
// BECAUSE THE OUTPUT IS DISPLAY-ONLY. A newer client may persist a kind this
// build has never heard of; this build cannot draw it, so it leaves it out of
// the list it renders. It can never DESTROY it, because every emitter writes a
// delta for ONE track id — nothing anywhere writes back a whole list derived
// from a merge. Break that rule and an old client silently deletes a new
// client's tracks the first time anyone touches the file.

export type TrackKind = "subtitles" | "source-audio" | "target-audio"

export interface TimelineTrack {
  /** Defaults use their kind as the id; user-added tracks carry a generated
   *  one. Persisted as a `trackOverrides` key and in event payloads, so an id
   *  is forever once written. */
  id: string
  kind: TrackKind
  name: string
  /** A sort key, not an index — negative and fractional values are legal so a
   *  future reorder can drop a track between two others without renumbering
   *  everything below it. */
  order: number
  groupId?: string | null
}

/**
 * One stored delta, as it sits in `files.meta.trackOverrides[trackId]`.
 *
 * Flat and allow-listed because the server merges it with jsonb `||` +
 * `jsonb_strip_nulls`, and strip_nulls is recursive: a nested field here would
 * drag its neighbours' nulls out with it. Null-free for the same reason — the
 * WIRE patch may carry `name: null` to clear an override, but what survives
 * into meta never does.
 */
export interface PersistedTrackPatch {
  /** Widened to `string` ON PURPOSE: a future client may have written a kind
   *  this build has never heard of, and the type has to be able to say so. */
  kind?: string
  name?: string
  order?: number
  groupId?: string
}

export type PersistedTrackOverrides = Record<string, PersistedTrackPatch>

export const TRACK_KIND_LABELS: Record<TrackKind, string> = {
  subtitles: "Subtitles",
  "source-audio": "Source audio",
  "target-audio": "Target audio",
}

/** The three rows the editor has drawn since it shipped, in the order it has
 *  always drawn them. */
const DEFAULT_TRACK_KINDS: readonly TrackKind[] = ["subtitles", "source-audio", "target-audio"]

export const DEFAULT_TRACK_IDS: ReadonlySet<string> = new Set<string>(DEFAULT_TRACK_KINDS)

/** Own-key check rather than `in`, because these strings arrive from remote
 *  JSON and `"constructor" in TRACK_KIND_LABELS` is true. Keyed off the label
 *  map so adding a kind stays one edit. */
const isTrackKind = (value: unknown): value is TrackKind =>
  typeof value === "string" && Object.hasOwn(TRACK_KIND_LABELS, value)

/** A persisted string override worth applying. Whitespace-only is treated as
 *  absent: it would render as a blank label with no way to tell it from a bug.
 *  The value is applied VERBATIM, not trimmed — a rename UI prefills from the
 *  merged track, so what is shown has to be what is stored or the next save
 *  quietly rewrites the user's name. */
const overrideString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null

const overrideOrder = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const isPatchObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A fresh array every call — the merge sorts and patches in place, and
 *  TimelineEditor holds one call's result as a module constant for referential
 *  stability. */
export function deriveDefaultTracks(): TimelineTrack[] {
  return DEFAULT_TRACK_KINDS.map((kind, order) => ({
    id: kind,
    kind,
    name: TRACK_KIND_LABELS[kind],
    order,
    groupId: null,
  }))
}

/**
 * Apply the stored deltas to the derived defaults.
 *
 * Pure, total (malformed input is skipped, never thrown on) and it never
 * mutates either argument. Defaults are patched in place on copies; entries
 * naming an id the defaults do not have are user-added tracks; an entry whose
 * kind this build does not recognise is dropped (see the forward-compatibility
 * note at the top of the file — the reason that is not data loss).
 *
 * Defaults cannot be deleted in stage 1: deletion is expressed by removing the
 * OVERRIDE entry, which returns the row to its pure default rather than taking
 * it away.
 *
 * TOTAL ORDER, so a reorder UI can rely on equal `order` values not jittering:
 * `order` ascending, then defaults before user-added tracks (defaults keeping
 * the sequence they were derived in), then id ascending by code point — not
 * `localeCompare`, which would sort differently for different users.
 */
export function mergeTrackOverrides(
  defaults: TimelineTrack[],
  overrides: PersistedTrackOverrides | null | undefined,
): TimelineTrack[] {
  const tracks: TimelineTrack[] = defaults.map((track) => ({ ...track }))
  const seats = new Map<string, number>()
  tracks.forEach((track, index) => seats.set(track.id, index))
  const userSeat = tracks.length

  const entries = overrides && isPatchObject(overrides) ? overrides : {}
  // Sorted key order, NOT the object's own: the same logical map reaches us
  // either from an object built here or from Postgres jsonb, which stores keys
  // by length-then-bytes rather than insertion order. Walking a stable order is
  // what makes the fallback `order` below identical on both paths.
  const ids = Object.keys(entries).sort()

  const added: { id: string; patch: PersistedTrackPatch }[] = []
  for (const id of ids) {
    const patch = entries[id]
    if (!isPatchObject(patch)) continue
    const seat = seats.get(id)
    if (seat !== undefined) {
      const target = tracks[seat]
      // `kind` is ignored on a default: its identity is derived from the row
      // the editor draws, so a stored kind could only ever be a lie about it.
      const name = overrideString(patch.name)
      if (name !== null) target.name = name
      const order = overrideOrder(patch.order)
      if (order !== null) target.order = order
      const groupId = overrideString(patch.groupId)
      if (groupId !== null) target.groupId = groupId
      continue
    }
    // A default id the caller left out of `defaults` stays reserved — a delta
    // must never resurrect "subtitles" as a user-added track just because it
    // was handed a shortened list.
    if (DEFAULT_TRACK_IDS.has(id)) continue
    added.push({ id, patch })
  }

  // Read AFTER patching: an unordered new track belongs below whatever the
  // defaults have actually been reordered to, not below where they started.
  let maxDefaultOrder = -1
  for (const track of tracks) if (track.order > maxDefaultOrder) maxDefaultOrder = track.order

  let unordered = 0
  for (const { id, patch } of added) {
    if (!isTrackKind(patch.kind)) continue
    const explicitOrder = overrideOrder(patch.order)
    const order = explicitOrder ?? maxDefaultOrder + 1 + unordered
    if (explicitOrder === null) unordered += 1
    tracks.push({
      id,
      kind: patch.kind,
      name: overrideString(patch.name) ?? TRACK_KIND_LABELS[patch.kind],
      order,
      groupId: overrideString(patch.groupId),
    })
  }

  return tracks.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    const seatA = seats.get(a.id) ?? userSeat
    const seatB = seats.get(b.id) ?? userSeat
    if (seatA !== seatB) return seatA - seatB
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** The tracks to draw for a file. Structurally typed rather than
 *  `Pick<FileReference, …>` so this module stays import-free — see the top of
 *  the file. */
export function deriveTracksForFile(
  file?: { trackOverrides?: PersistedTrackOverrides | null } | null,
): TimelineTrack[] {
  return mergeTrackOverrides(deriveDefaultTracks(), file?.trackOverrides)
}
