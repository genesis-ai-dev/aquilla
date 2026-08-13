// AQU-904 — named TEXT tracks inside one timeline file.
//
// Come and See's episodes ship two VTTs whose timestamps disagree: one for
// subtitles, one for the dub/audio pass. Both belong on the SAME timeline
// (one project + one file per episode), so a timed text cell now carries which
// track it came from in its extensible `metadata` bucket — no schema change,
// same trick OBS frame attachments use:
//
//     metadata.timelineTrack = { id, label, kind }
//
// Cells with no tag (every pre-AQU-904 import, and the subtitle lane's AQU-646
// media mirror) belong to the DEFAULT track, which always renders first and
// keeps the lane the editor has always shown. Pure module: nothing here reads
// or writes anything.

/** What a text track is for. Drives its sub-label and default naming only —
 *  both kinds are timed text cells and lay out identically. */
export type TimelineTrackKind = "subtitle" | "audio"

export interface TimelineTrackRef {
  /** Stable id, minted at import. `DEFAULT_TRACK_ID` for untagged cells. */
  id: string
  /** Shown in the 128px lane-label column — usually the imported filename. */
  label: string
  kind: TimelineTrackKind
}

/** The track untagged timed-text cells belong to (the original Subtitles lane). */
export const DEFAULT_TRACK_ID = "default"

/** Cells carry their track under this key inside `metadata`. */
const TRACK_METADATA_KEY = "timelineTrack"

/** Minimal shape this module needs; `CellData` satisfies it structurally. */
export interface TrackTaggedCell {
  metadata?: Record<string, unknown> | null
}

/** Metadata bucket entry for a track-tagged cell (spread into the emit). */
export function buildTrackMetadata(track: TimelineTrackRef): Record<string, unknown> {
  return { [TRACK_METADATA_KEY]: { id: track.id, label: track.label, kind: track.kind } }
}

/**
 * Read a cell's track tag. Returns null for untagged cells AND for anything
 * malformed — a bad tag must never lose a cue, it just falls back to the
 * default track (metadata is an open bucket others write to).
 */
export function readTrackRef(cell: TrackTaggedCell): TimelineTrackRef | null {
  const raw = cell.metadata?.[TRACK_METADATA_KEY]
  if (!raw || typeof raw !== "object") return null
  const t = raw as Partial<Record<keyof TimelineTrackRef, unknown>>
  if (typeof t.id !== "string" || t.id === "") return null
  const kind: TimelineTrackKind = t.kind === "audio" ? "audio" : "subtitle"
  const label = typeof t.label === "string" && t.label.trim() !== "" ? t.label : t.id
  return { id: t.id, label, kind }
}

export interface DerivedTrack<T> {
  id: string
  label: string
  kind: TimelineTrackKind
  /** True for the untagged fallback track (renders with the built-in copy). */
  isDefault: boolean
  cells: T[]
}

/**
 * Split an already lane-filtered, already time-sorted list of timed text cells
 * into one entry per track, preserving each cell's incoming order.
 *
 * The default track is emitted FIRST and only when it has cells, so a file that
 * has never seen a track import derives exactly one track — byte-for-byte the
 * lane the editor rendered before. Imported tracks follow in first-appearance
 * order (i.e. import order, since cues are appended).
 */
export function deriveTracks<T extends TrackTaggedCell>(
  cells: readonly T[],
  defaultLabel: string,
): DerivedTrack<T>[] {
  const byId = new Map<string, DerivedTrack<T>>()
  const order: string[] = []
  for (const cell of cells) {
    const ref = readTrackRef(cell)
    const id = ref?.id ?? DEFAULT_TRACK_ID
    let track = byId.get(id)
    if (!track) {
      track = {
        id,
        label: ref?.label ?? defaultLabel,
        kind: ref?.kind ?? "subtitle",
        isDefault: ref === null,
        cells: [],
      }
      byId.set(id, track)
      order.push(id)
    }
    track.cells.push(cell)
  }
  return order
    .map((id) => byId.get(id)!)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}
