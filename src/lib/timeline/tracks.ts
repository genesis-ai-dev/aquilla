// The timeline track contract. (AQU-646 stage 1; renamed and made file-aware
// in stage 2)
//
// Until now a "track" was three hardcoded rows of JSX in TimelineEditor plus a
// hand-mirrored label gutter — there was no entity to rename, reorder or group,
// which is exactly what The Chosen's per-episode text/audio/character files
// need. This module is the single owner of that entity: WHICH ROWS A GIVEN
// FILE DERIVES, the deltas persisted against them, and the merge that turns the
// two into the list the editor draws.
//
// TRACKS ARE CUE DATA, AND THE FILM'S SOUNDTRACK GETS NO ROW, EVER. The picture
// is heard from the video pane whatever the timeline shows, so there is nothing
// for a "the film's own audio" row to hold. "Source audio" is the row for the
// AUDIO VTT's cues — a near-verbatim transcript of that soundtrack, imported as
// a hidden sibling file — and until such an import exists there is nothing to
// draw and the row is simply absent. That is why derivation takes a
// TrackDerivationContext instead of being a constant: which rows exist is a
// property of the FILE, not of the app.
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

// RENAMED IN STAGE 2, AND THAT WAS ONLY FREE BECAUSE OF A WINDOW THAT IS NOW
// SPENT: the branch is unpushed and `file.track.set` is dormant, so no event,
// no `files.meta.trackOverrides` entry and no exported project anywhere has
// ever carried the old "subtitles" spelling. Once a single one does, a rename
// here stops being a rename and becomes a migration of stored deltas.
//
// THE UNION IS SPLIT IN TWO, AND THE SPLIT IS LOAD-BEARING. A DERIVED kind is
// one the FILE produces from its own shape — those four, and only those four,
// have a frozen seat in TRACK_KIND_ORDER and an id reserved in
// DEFAULT_TRACK_IDS. An ADDED kind is one a user picks when they make a track,
// and it has neither: it can never be derived, so inventing a dummy seat for it
// would be inventing a number that nothing reads. Keeping them apart is what
// lets `Record<DerivedTrackKind, number>` stay exhaustive and honest instead of
// growing filler entries every time the palette of addable tracks widens.
export type DerivedTrackKind = "source-subtitles" | "source-audio" | "target-subtitles" | "target-audio"

/** What a user can make. `"audio"` is deliberately NOT `"target-audio"`: the
 *  derived row of that kind is the file's own dub track, whose takes live in the
 *  `"recording"` slot and whose alignment comes from the file's cells. An added
 *  audio track has neither — it carries a `sourceTrackId` saying what it lines
 *  up against, and (from stage 3) its own slot. Same lane, different contract,
 *  so a different kind. */
export type AddedTrackKind = "folder" | "audio"

export type TrackKind = DerivedTrackKind | AddedTrackKind

export interface TimelineTrack {
  /** Defaults use their kind as the id; user-added tracks carry a generated
   *  one. Persisted as a `trackOverrides` key and in event payloads, so an id
   *  is forever once written. */
  id: string
  kind: TrackKind
  name: string
  /** A sort key, not an index — negative and fractional values are legal so a
   *  future reorder can drop a track between two others without renumbering
   *  everything below it.
   *
   *  SCOPED, from stage 2 on: a top-level track's order ranks it among the
   *  other top-level rows, and a folder member's ranks it among its siblings.
   *  Comparing across scopes is meaningless — see track-groups.ts. Existing
   *  data is unaffected: every persisted order today is top-level, and with no
   *  folders "scoped" and "global" are the same statement. */
  order: number
  groupId?: string | null
  /** A palette ID from track-colors.ts, or null/absent for the default pair.
   *  An ID rather than colour values, because what a palette entry looks like
   *  is this build's business — see the note on PersistedTrackPatch.color. */
  color?: string | null
  /** Which track's cells this one's chips line up with. Set once, at creation,
   *  on added tracks only: a derived row's alignment comes from the file, so
   *  there is nothing here to override. */
  sourceTrackId?: string | null
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
  /** A palette ID, NOT colour values — and widened to `string` for the same
   *  reason `kind` is. Which hues an ID stands for is decided by whichever
   *  build is drawing, exactly as TRACK_RENDER already decides what the derived
   *  rows look like. Storing hex here would freeze one build's palette into
   *  every project's data and make a future restyle a migration; storing an ID
   *  this build cannot name simply falls back to the default pair, and the
   *  newer client that wrote it still sees what it meant. */
  color?: string
  sourceTrackId?: string
}

export type PersistedTrackOverrides = Record<string, PersistedTrackPatch>

export const TRACK_KIND_LABELS: Record<TrackKind, string> = {
  // Sam, 2026-08-24: "text", not "subtitles". The row holds the file's source
  // text whatever it came from — a subtitle import, a transcript, an ordinary
  // document — and calling every one of them a subtitle names the narrowest
  // case. THE KIND STRINGS ARE UNCHANGED: they are persisted in
  // files.meta.trackOverrides and renaming one would be a migration. This is
  // only what the row is CALLED, which is per-track data a rename overrides —
  // so a project that wants "Subtitles" back simply renames it.
  "source-subtitles": "Source text",
  "source-audio": "Source audio",
  "target-subtitles": "Target text",
  "target-audio": "Target audio",
  folder: "Folder",
  audio: "Audio",
}

/**
 * THE RESERVED IDS — every kind, not "the rows this file starts with".
 *
 * The distinction is load-bearing and easy to misread now that derivation is
 * file-aware. A media file derives three rows and never a `target-subtitles`
 * one; if this set only listed the rows it DID derive, the reserved-id rule in
 * mergeTrackOverrides would happily build `target-subtitles` as a "user-added"
 * track out of a stray delta — a second, half-real row wearing a default's id,
 * which the next reorder or rename would then write against. Reserving all four
 * kinds means a delta naming one this file does not derive is simply ignored.
 *
 * ONLY THE DERIVED KINDS ARE IDS. It used to be every kind, because every kind
 * was derived; now that a user can make a `folder` or an `audio` track, the two
 * sets have come apart and aliasing them would reserve `"folder"` as a track id
 * — which would make a user-added track that happened to be handed that id
 * unbuildable, and for no reason: nothing ever DERIVES a folder, so there is no
 * derived row for a delta to collide with.
 *
 * HAND-MIRRORED with `TRACK_KINDS`/`DEFAULT_TRACK_IDS` in
 * sync-worker/src/events/handlers/file-track-set.ts: the packages share no
 * code, so both sides must be edited together. Drift the other way — a kind the
 * client will happily persist that the server rejects — wedges the outbox on a
 * permanently-failing event.
 */
const DERIVED_TRACK_KINDS: readonly DerivedTrackKind[] = [
  "source-subtitles",
  "source-audio",
  "target-subtitles",
  "target-audio",
]

export const DEFAULT_TRACK_IDS: ReadonlySet<string> = new Set<string>(DERIVED_TRACK_KINDS)

/** The canonical seat of each kind. Derivation uses THESE and never the array
 *  index, so the numbers a file's rows carry do not shift underneath a user's
 *  persisted reorder when the Source-audio row appears later (an audio VTT is
 *  imported) or goes away again (it is deleted). An index-based order would
 *  quietly re-point an override that said `order: 1.5` at a different pair of
 *  neighbours.
 *
 *  THESE VALUES ARE FROZEN THE MOMENT ANYTHING PERSISTS AN ORDER. A stored
 *  `order` is an absolute number, not a reference to a seat, so renumbering
 *  seats afterwards moves every un-reordered row out from under every reordered
 *  one — a data migration, not an edit. Stage 3 renumbers Target subtitles from
 *  2 to 1 (Sam's new default: it belongs directly under Source subtitles) and
 *  that is free ONLY because `file.track.set` has never been emitted, so no
 *  `trackOverrides` entry exists anywhere. SEQUENCING CONSTRAINT: this renumber
 *  must ship in the same release as the drag-to-reorder that starts emitting.
 *  Ship the drag first and the window closes. */
const TRACK_KIND_ORDER: Record<DerivedTrackKind, number> = {
  "source-subtitles": 0,
  "target-subtitles": 1,
  "source-audio": 2,
  "target-audio": 3,
}

/**
 * What the file itself says about which rows it should have.
 *
 * Structural, like `deriveTracksForFile`'s file parameter, so this module stays
 * import-free — see the top of the file.
 */
export interface TrackDerivationContext {
  /** The file was imported from subtitles: its cells are timed text, and the
   *  translation of that text is a row in its own right. */
  isSubtitleImport: boolean
  /** The file has media cells — a dubbing project, whose three rows are
   *  Source text / Source audio / Target audio. */
  hasMediaCells: boolean
  /** An audio-cue sibling file exists for this file, so there are cues for a
   *  Source-audio row to draw. */
  hasAudioCues: boolean
}

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

const trackRow = (kind: DerivedTrackKind, name: string = TRACK_KIND_LABELS[kind]): TimelineTrack => ({
  id: kind,
  kind,
  name,
  order: TRACK_KIND_ORDER[kind],
  groupId: null,
})

/**
 * The rows a file derives before any stored delta is applied.
 *
 * A fresh array every call — the merge sorts and patches in place, and
 * TimelineEditor holds one call's result as a module constant for referential
 * stability.
 *
 * With no context (the fileless caller) or with media cells, this is the
 * three-row shape the editor has drawn since it shipped, rows and labels
 * unchanged: every existing dubbing project must see NOTHING different after
 * stage 2.
 *
 * The source row used to spell its own name here — the literal "Subtitles",
 * overriding the kind's label, because a dubbing file's gutter had read that
 * since the editor shipped. The 2026-08-24 rename removed the override rather
 * than editing it: with both spellings becoming "Source text" the divergence
 * had nothing left to express, and one name for one kind is the simpler thing
 * to keep true. Both file shapes now take the label from the kind.
 *
 * A PROJECT THAT WANTS "Subtitles" BACK RENAMES THE ROW — that is data, it
 * wins over anything derived here, and this function never sees it.
 *
 * THE LITERALS BELOW ARE WRITTEN IN SEAT ORDER, AND THAT IS A CONTRACT, NOT
 * TIDINESS. This function does not sort — only mergeTrackOverrides does — so
 * the array it returns IS what an override-free file draws, and its index is
 * also the `seats` map the merge uses as its tie-break. Reseat a kind without
 * moving its literal and both go wrong at once, silently: the rows render in
 * the old sequence, and the tie-break goes on encoding the old sequence too.
 * (`deriveDefaultTracks returns its rows already in ascending order` in
 * tracks.test.ts is the guard.)
 */
export function deriveDefaultTracks(context?: TrackDerivationContext | null): TimelineTrack[] {
  // hasMediaCells WINS. A file cannot honestly be both — media cells and
  // imported subtitle cells are different `medium` values on the same file, and
  // the import pipelines that set them are mutually exclusive — so if both
  // flags arrive true the caller is looking at a file mid-transition or at a
  // stale memo, and the legacy three-row shape is the safe answer: it is what
  // the file was drawn as a moment ago, and it never hides a row.
  //
  // THE STAGE-3 RESEAT MUST NOT BE VISIBLE IN THIS SHAPE. These three rows'
  // orders went [0, 1, 3] → [0, 2, 3] — same rows, same sequence, still
  // ascending — and a dubbing file cannot observe the
  // difference: nothing derives seat 1 on a file with no Target-subtitles row,
  // and with no persisted overrides (the state every existing project is in)
  // these numbers are never compared against anything but each other. That
  // invisibility is the guarantee the whole renumber hangs on; it is the
  // highest-blast-radius part of the change and tracks.test.ts pins it twice.
  if (!context || context.hasMediaCells || !context.isSubtitleImport) {
    return [trackRow("source-subtitles"), trackRow("source-audio"), trackRow("target-audio")]
  }

  return [
    trackRow("source-subtitles"),
    trackRow("target-subtitles"),
    // No audio VTT imported yet means no cues, and a row with nothing to draw
    // is worse than no row: it reads as "this episode has no speech".
    ...(context.hasAudioCues ? [trackRow("source-audio")] : []),
    trackRow("target-audio"),
  ]
}

/**
 * THE total order over tracks, and the only one: `order` ascending, then the
 * derived seat (so defaults keep the sequence they were derived in when their
 * orders are equal), then id ascending by code point — not `localeCompare`,
 * which would sort differently for different users.
 *
 * Exported rather than inlined into the merge because the drag-to-reorder
 * overlay sorts its own optimistically-patched copy of the list. Two
 * implementations of this can only ever differ on a TIE — and equal `order`
 * values are a real, reachable state (see the total-order cases in
 * tracks.test.ts) — so the row would swap places between the optimistic list
 * and the settled one at the exact instant the user let go of it.
 *
 * `seats` is the PRE-patch derived index. Ids it does not know (user-added
 * tracks) take `fallbackSeat`, which callers set past the last default so those
 * tracks sort below every default they tie with.
 */
export function compareTracksBySeat(
  seats: ReadonlyMap<string, number>,
  fallbackSeat: number,
): (a: TimelineTrack, b: TimelineTrack) => number {
  return (a, b) => {
    if (a.order !== b.order) return a.order - b.order
    const seatA = seats.get(a.id) ?? fallbackSeat
    const seatB = seats.get(b.id) ?? fallbackSeat
    if (seatA !== seatB) return seatA - seatB
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
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
 * Sorted by `compareTracksBySeat` above, so a reorder UI can rely on equal
 * `order` values not jittering.
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
      // `kind` and `sourceTrackId` are ignored on a default: both are derived
      // from the row the editor draws — its identity and what its chips line up
      // with — so a stored value could only ever be a lie about it. (The server
      // refuses both on a reserved id, so this branch is defence in depth
      // against data that predates that rule or arrives from a newer client.)
      const name = overrideString(patch.name)
      if (name !== null) target.name = name
      const order = overrideOrder(patch.order)
      if (order !== null) target.order = order
      const groupId = overrideString(patch.groupId)
      if (groupId !== null) target.groupId = groupId
      // Colour IS honoured on a default, and has to be: the default target-audio
      // row is the one every existing project is looking at, and it is the first
      // track anyone will recolour.
      const color = overrideString(patch.color)
      if (color !== null) target.color = color
      continue
    }
    // A reserved id the caller left out of `defaults` stays reserved — a delta
    // must never resurrect "source-subtitles" (or "target-subtitles" on a file
    // that does not derive it) as a user-added track just because it is absent
    // from the list handed in.
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
      color: overrideString(patch.color),
      // Self-reference is dropped rather than rejected — the track still
      // exists, it just aligns to nothing, which is exactly how a groupId
      // naming a track this build cannot see already behaves.
      sourceTrackId: overrideString(patch.sourceTrackId) === id ? null : overrideString(patch.sourceTrackId),
    })
  }

  return tracks.sort(compareTracksBySeat(seats, userSeat))
}

/** The tracks to draw for a file: the rows its context derives, patched with
 *  the deltas it has stored. Structurally typed rather than
 *  `Pick<FileReference, …>` so this module stays import-free — see the top of
 *  the file. The context is separate from `file` because it is computed from
 *  the file's CELLS and its audio-cue sibling, neither of which lives on the
 *  FileReference. */
export function deriveTracksForFile(
  file?: { trackOverrides?: PersistedTrackOverrides | null } | null,
  context?: TrackDerivationContext | null,
): TimelineTrack[] {
  return mergeTrackOverrides(deriveDefaultTracks(context), file?.trackOverrides)
}
