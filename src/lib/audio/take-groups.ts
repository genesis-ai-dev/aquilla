// A line's takes, grouped by the track each sits on, and which one PLAYS on
// each track.
//
// Lifted out of the recorder (2026-09-29) so the expanded cell's Recording tab
// lists exactly the groups the recorder's takes list does: the default track's
// two slots (recordings and generated voices) together as ONE list, since only
// one of them can play, and each added track on its own.

import { audioIdSeededWith, isDenoisedAudioId } from "@/lib/audio/upload"
import { pieceGroupOf, slotSelections, type AudioAttachmentOut, type CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { DEFAULT_TARGET_TRACK_ID, slotForTrack, trackIdForSlot } from "@/lib/timeline/track-slots"

export interface TakeGroup {
  trackId: string
  /** The track's display name, or "" for a track this build cannot name. */
  name: string
  takes: AudioAttachmentOut[]
}

type Selections = Pick<CellAudioEntry, "selectedBySlot" | "selectedAudioId" | "selectedGeneratedVoiceAudioId">

/**
 * EVERY track's takes on one line, grouped, in the file's own track order, so
 * the headings read down the list the way the lanes read down the timeline.
 * Tracks this build cannot name (a collaborator's newer one) still list their
 * takes rather than hiding them. Takes sort by id within a group.
 *
 * The imported SOURCE clip rides the recording slot but is not a take (it is
 * seeded with the file's id, not the cell's), and a take removed but not yet
 * gone from the read is not one either.
 */
export function groupTakesByTrack(
  attachments: Readonly<Record<string, AudioAttachmentOut>> | null | undefined,
  fileId: string,
  tracks: ReadonlyArray<{ id: string; name: string }> | null | undefined,
): TakeGroup[] {
  const all = Object.values(attachments ?? {})
    .filter((a) => !audioIdSeededWith(a.audioId, fileId))
    .filter((a) => !(a as { isDeleted?: boolean }).isDeleted)
  const byTrack = new Map<string, AudioAttachmentOut[]>()
  for (const att of all) {
    const trackId = trackIdForSlot(att.slot)
    const list = byTrack.get(trackId)
    if (list) list.push(att)
    else byTrack.set(trackId, [att])
  }
  const ordered = (tracks ?? []).filter((tr) => byTrack.has(tr.id))
  const named = new Set(ordered.map((tr) => tr.id))
  return [
    ...ordered.map((tr) => ({ trackId: tr.id, name: tr.name, takes: byTrack.get(tr.id)! })),
    ...[...byTrack.entries()]
      .filter(([id]) => !named.has(id))
      .map(([id, takes]) => ({ trackId: id, name: "", takes })),
  ].map((g) => ({ ...g, takes: g.takes.sort((a, b) => a.audioId.localeCompare(b.audioId)) }))
}

/**
 * The pointer a group's list circles: for the default track its recording
 * pointer (which may be the source clip — the list falls through to the
 * generated one itself), for an added track that track's single slot.
 */
export function groupSelection(entry: Selections | null | undefined, trackId: string): string | null {
  if (trackId === DEFAULT_TARGET_TRACK_ID) return entry?.selectedAudioId ?? null
  const selections = slotSelections(entry ?? { selectedAudioId: null, selectedGeneratedVoiceAudioId: null })
  return selections[slotForTrack(trackId)] ?? null
}

/**
 * The take that PLAYS for a group, mirroring playback's preference: on the
 * default track a recorded take holding the recording slot wins, otherwise the
 * selected generated voice; on an added track, its slot's selection. Null when
 * no take of the group plays (a line whose recording slot holds only the
 * imported source clip, and no generated voice).
 */
export function playingTakeId(group: TakeGroup, entry: Selections | null | undefined): string | null {
  const has = (id: string | null | undefined): id is string => Boolean(id && group.takes.some((t) => t.audioId === id))
  const selected = groupSelection(entry, group.trackId)
  if (has(selected)) return selected
  if (group.trackId === DEFAULT_TARGET_TRACK_ID && has(entry?.selectedGeneratedVoiceAudioId)) {
    return entry!.selectedGeneratedVoiceAudioId!
  }
  return null
}

/**
 * AQU-1767 (Sam, 2026-10-14): a take as the lists show it. A take that was split
 * is ONE take made of pieces, never a row per piece; one never split is a take
 * of one piece.
 */
export interface TakeRow {
  /** The group's id: the take the pieces were cut from. */
  group: string
  /** Its live pieces in CLIP order (where each starts in the recording). */
  pieces: AudioAttachmentOut[]
}

const clipOrder = (a: AudioAttachmentOut, b: AudioAttachmentOut) =>
  (a.trimStartMs ?? 0) - (b.trimStartMs ?? 0) || a.audioId.localeCompare(b.audioId)

/** `takes` as takes: each split take once, in the order its first piece came. */
export function takeRows(takes: readonly AudioAttachmentOut[]): TakeRow[] {
  const byGroup = new Map<string, AudioAttachmentOut[]>()
  for (const att of takes) {
    if ((att as { isDeleted?: boolean }).isDeleted) continue
    const group = pieceGroupOf(att, att.audioId)
    const list = byGroup.get(group)
    if (list) list.push(att)
    else byGroup.set(group, [att])
  }
  return [...byGroup.entries()].map(([group, pieces]) => ({ group, pieces: pieces.sort(clipOrder) }))
}

/** The live pieces of the take `audioId` belongs to, in clip order (just it, if never split). */
export function piecesOf(takes: readonly AudioAttachmentOut[], audioId: string | null | undefined): AudioAttachmentOut[] {
  if (!audioId) return []
  const att = takes.find((a) => a.audioId === audioId)
  if (!att) return []
  const group = pieceGroupOf(att, audioId)
  return takeRows(takes).find((row) => row.group === group)?.pieces ?? [att]
}

/** "Take 3 · 2" → "Take 3": the name a split take goes by. Null when unnamed. */
export function takeBaseLabel(label: string | null | undefined): string | null {
  if (!label) return null
  return label.replace(/\s·\s\d+$/, "")
}

/**
 * AQU-1767 (Sam, 2026-10-15): the name each take goes by, keyed by audioId. A
 * split take's pieces are its name numbered by where each sits in the
 * recording, 1, 2, 3…, worked out here every time and never read from the
 * number stored on a piece, so a split, a deleted piece or an undo renumbers
 * them at once. A take never split (or split down to one piece) keeps its own
 * name. Null where a piece's take has no name.
 */
export function pieceNames(
  takes: readonly Pick<AudioAttachmentOut, "audioId" | "label" | "pieceOf" | "trimStartMs">[],
): Map<string, string | null> {
  const names = new Map<string, string | null>()
  for (const row of takeRows(takes as AudioAttachmentOut[])) {
    if (row.pieces.length === 1) {
      names.set(row.pieces[0].audioId, row.pieces[0].label ?? null)
      continue
    }
    const base = takeBaseLabel(row.pieces[0].label)
    row.pieces.forEach((p, i) => names.set(p.audioId, base ? `${base} · ${i + 1}` : null))
  }
  return names
}

/**
 * AQU-1767 (Sam, 2026-10-15): the recording a take's words were spoken in —
 * the take a piece was cut from, and behind a cleaned copy (Remove noise) the
 * take it was cleaned from. A piece is created when it is cut and a cleaned
 * copy when the noise is removed, but the words are as old as the recording,
 * so "when was it recorded" and "has the text changed since" ask this one.
 */
export function originalRecordingId(
  takes: Readonly<Record<string, { pieceOf?: string | null; referenceAudioId?: string | null } | undefined>>,
  audioId: string,
): string {
  let id = audioId
  for (let hops = 0; hops < 8; hops++) {
    const root = takes[id]?.pieceOf ?? id
    const from = isDenoisedAudioId(root) ? takes[root]?.referenceAudioId : null
    if (!from || !takes[from] || from === root) return root
    id = from
  }
  return id
}

/**
 * How many takes the recorder's list shows, across every track. AQU-981 (Sam,
 * 2026-10-29): a take split into pieces is one take, so it counts once, as it
 * is one row in the list.
 */
export function listedTakeCount(groups: readonly TakeGroup[]): number {
  return groups.reduce((n, g) => n + takeRows(g.takes).length, 0)
}
