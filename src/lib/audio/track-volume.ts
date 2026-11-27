// AQU-2664 (board 74): a track's own volume — the fader in its header.
//
// Stored on the file's track (`file.track.set` patch `volumeDb`, null = 0 dB),
// so it is SHARED: everyone hears it and every export applies it. It is the
// fourth stage of a take's level (take-gain.ts):
//
//     recording → evening out → the take's volume and fades → TRACK VOLUME
//               → main volume → peak guard
//
// Playback applies it in the mixer's track node (`setTrackGainDb`), and an
// export multiplies each clip by it (`withTrackVolumes` + clip-level.ts).
// −∞ (stored "-inf") is silence in both: a gain of 0.
// Mute and solo are NOT here: they are personal (audibility.ts).

import { useSyncExternalStore } from "react"
import type { CellData } from "@/hooks/useCells"
import { setTrackGainDb } from "./mixer"
import { slotsForTrack, trackIdForSlot } from "@/lib/timeline/track-slots"
import { overrideVolumeDb, TRACK_KIND_LABELS, type PersistedTrackOverrides, type TimelineTrack } from "@/lib/timeline/tracks"
import { fromStoredVolume, toStoredVolume } from "./track-volume-store"

// The fader's scale, its typing and its readout live in fader-scale.ts; what
// it holds and how that is stored, in track-volume-store.ts.

const sign = (r: number) => (r > 0 ? "+" : r < 0 ? "−" : "")

/** A take's own volume as the Station line reads it: "0 dB", "−2 dB", "+1.5 dB". */
export function formatOwnVolume(db: number): string {
  const r = Math.round(db * 10) / 10
  const n = Math.abs(r)
  return `${sign(r)}${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1)} dB`
}

/** Hand each audio track's volume to the mixer, under every slot it plays on. */
export function applyTrackVolumes(tracks: readonly TimelineTrack[]): void {
  for (const tr of tracks) {
    if (tr.kind !== "audio" && tr.kind !== "target-audio") continue
    for (const slot of slotsForTrack(tr.id)) setTrackGainDb(slot, tr.volumeDb ?? 0)
  }
}

// ── The film's own sound (Sam, Nov 27) ──────────────────────────────────────
//
// The film's row carries a volume slider beside its M | S, like every other
// track. The film's sound is the "source" switch (the film's row on a linked
// film, the Source audio row in an imported film's folder), so its volume is
// ONE value, stored where a track's is: on the Source audio row's id (a
// built-in id, so the server takes a volume-only patch on it on every file),
// even on a file that draws no Source audio row. It plays in two places:
//   • the mixer's "source" stage, where an imported film's Source audio plays;
//   • the film's own <video> element (MediaVideoPane), as its volume: the
//     bar's volume times this level. An element cannot go over 1, so above
//     0 dB it plays at full; −∞ mutes it, which iPhone and iPad honour (they
//     ignore an element's volume).
// It is playback only: the film's sound is never in an export.

/** Where the film's volume is stored: the Source audio row's id. */
export const FILM_SOUND_TRACK_ID = "source-audio"
/** The mixer stage (and the audibility switch) the film's sound plays on. */
export const FILM_SOUND_MIXER_KEY = "source"

/** The film's stored volume, dB (0 when none). */
export function filmSoundDb(overrides: PersistedTrackOverrides | null | undefined): number {
  return overrideVolumeDb(overrides?.[FILM_SOUND_TRACK_ID]?.volumeDb) ?? 0
}

/**
 * The tracks as a read for the film's volume: the drawn ones, plus a stand-in
 * Source audio row when the file draws none (a linked film with no recording
 * of its own). For reads only — "what was it before", "has my write landed" —
 * never drawn.
 */
export function withFilmSoundRow(tracks: readonly TimelineTrack[], overrides: PersistedTrackOverrides | null | undefined): TimelineTrack[] {
  if (tracks.some((t) => t.id === FILM_SOUND_TRACK_ID)) return tracks as TimelineTrack[]
  const db = filmSoundDb(overrides)
  return [...tracks, {
    id: FILM_SOUND_TRACK_ID,
    kind: "source-audio",
    name: TRACK_KIND_LABELS["source-audio"],
    order: -1,
    ...(db ? { volumeDb: db } : {}),
  }]
}

let filmDb = 0
const filmListeners = new Set<() => void>()
const subscribeFilm = (l: () => void) => {
  filmListeners.add(l)
  return () => { filmListeners.delete(l) }
}

/** The film's volume, dB, to the mixer's source stage and the film's element.
 *  Called when the stored value changes and on every drawn frame of a drag. */
export function applyFilmSoundDb(db: number): void {
  setTrackGainDb(FILM_SOUND_MIXER_KEY, db)
  if (Object.is(filmDb, db)) return
  filmDb = db
  for (const l of [...filmListeners]) l()
}

export function getFilmSoundDb(): number {
  return filmDb
}

/** The film's volume for the film's element (MediaVideoPane). */
export function useFilmSoundDb(): number {
  return useSyncExternalStore(subscribeFilm, getFilmSoundDb, () => 0)
}

/** The film element's volume: the bar's (0…1) times the film's level. */
export function filmElementVolume(base: number, db: number): number {
  if (db === -Infinity) return 0
  const v = base * Math.pow(10, db / 20)
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : Math.max(0, Math.min(1, base))
}

/** The stored volume of the track a slot belongs to, dB (0 when none). */
export function trackVolumeForSlot(overrides: PersistedTrackOverrides | null | undefined, slot: string): number {
  return overrideVolumeDb(overrides?.[trackIdForSlot(slot)]?.volumeDb) ?? 0
}

/** The tracks' volumes in the stored shape `withTrackVolumes` reads, for a
 *  caller holding the drawn tracks rather than the file's overrides. */
export function trackVolumeOverrides(tracks: readonly TimelineTrack[] | null | undefined): PersistedTrackOverrides {
  const out: PersistedTrackOverrides = {}
  for (const tr of tracks ?? []) {
    const stored = tr.volumeDb ? toStoredVolume(tr.volumeDb) : null
    if (stored != null) out[tr.id] = { volumeDb: stored }
  }
  return out
}

/**
 * For an export: the cells with each take stamped with its track's volume
 * (`trackGainDb`, read by clip-level.ts). Copies only what changes; the same
 * array back when no track has a volume.
 */
export function withTrackVolumes(cells: CellData[], overrides: PersistedTrackOverrides | null | undefined): CellData[] {
  if (!overrides || !Object.values(overrides).some((p) => overrideVolumeDb(p?.volumeDb))) return cells
  return cells.map((cell) => {
    const atts = cell.attachments
    if (!atts) return cell
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [id, att] of Object.entries(atts)) {
      const db = att && att.role !== "source" ? trackVolumeForSlot(overrides, att.slot ?? "recording") : 0
      if (db) {
        next[id] = { ...att, trackGainDb: db }
        changed = true
      } else next[id] = att
    }
    return changed ? ({ ...cell, attachments: next } as CellData) : cell
  })
}

/** A volume written here that the project read hasn't shown yet: drawn now,
 *  so the fader doesn't jump back while the write travels. `readBefore` is
 *  what the read said when it was written; `id` names the write. */
export interface PendingVolume {
  db: number
  readBefore: number
  id: number
  /** Re-check S1: the values this tab wrote on the track before this one,
   *  while they were still pending. A read showing one of them is your own
   *  earlier write landing, not a colleague's. */
  mine?: number[]
}

/** A new write on a track: it keeps the first write's `readBefore` and
 *  remembers the values written since, so two quick writes don't spring back. */
export function nextPendingVolume(prev: PendingVolume | undefined, db: number, readNow: number, id: number): PendingVolume {
  if (!prev) return { db, readBefore: readNow, id, mine: [] }
  return { db, readBefore: prev.readBefore, id, mine: [...(prev.mine ?? []), prev.db] }
}

export function applyPendingVolumes(tracks: TimelineTrack[], pending: ReadonlyMap<string, PendingVolume>): TimelineTrack[] {
  if (pending.size === 0) return tracks
  return tracks.map((tr) => {
    const p = pending.get(tr.id)
    if (!p) return tr
    const next = { ...tr }
    if (p.db) next.volumeDb = p.db
    else delete next.volumeDb
    return next
  })
}

/**
 * The pending volumes to drop now: the read shows yours (your write landed),
 * or shows a value that is neither yours nor the one before (review S3: a
 * colleague's newer write — the fader then shows theirs), or the track is gone.
 */
export function settledPendingVolumes(pending: ReadonlyMap<string, PendingVolume>, tracks: readonly TimelineTrack[]): string[] {
  const out: string[] = []
  for (const [id, p] of pending) {
    const tr = tracks.find((t) => t.id === id)
    const read = tr?.volumeDb ?? 0
    // Yours landed, or a value that is neither the one before nor one of
    // your own earlier writes: a colleague's, newer than yours.
    if (!tr || read === p.db || (read !== p.readBefore && !(p.mine ?? []).includes(read))) out.push(id)
  }
  return out
}

/**
 * Evidence pass, Nov 27: an Undo or Redo of a track's volume, drawn like a new
 * write (`nextPendingVolume`) on top of the pending volumes, so a fader whose
 * drag has not been read back yet shows the level the Undo wrote, and settles
 * when the read shows it. `patch.volumeDb` is the stored form (null = 0 dB,
 * "-inf" = silence). Null when no patch changes a volume.
 */
export function pendingVolumesForPatches(
  pending: ReadonlyMap<string, PendingVolume>,
  changes: ReadonlyArray<{ trackId: string; patch: { volumeDb?: unknown } | Record<string, unknown> | null }>,
  readNow: (trackId: string) => number,
  id: number,
): Map<string, PendingVolume> | null {
  let next: Map<string, PendingVolume> | null = null
  for (const c of changes) {
    if (!c.patch || !("volumeDb" in c.patch)) continue
    const db = c.patch.volumeDb == null ? 0 : fromStoredVolume(c.patch.volumeDb)
    if (db === undefined) continue
    next ??= new Map(pending)
    next.set(c.trackId, nextPendingVolume(next.get(c.trackId), db, readNow(c.trackId), id))
  }
  return next
}

/** A refused write takes back only itself, never a newer one on the same track. */
export function withoutPendingVolume(pending: ReadonlyMap<string, PendingVolume>, trackId: string, writeId: number): Map<string, PendingVolume> {
  const next = new Map(pending)
  if (next.get(trackId)?.id === writeId) next.delete(trackId)
  return next
}
