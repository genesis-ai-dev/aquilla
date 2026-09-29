// A line's takes, grouped by the track each sits on, and which one PLAYS on
// each track.
//
// Lifted out of the recorder (2026-09-29) so the expanded cell's Recording tab
// lists exactly the groups the recorder's takes list does: the default track's
// two slots (recordings and generated voices) together as ONE list, since only
// one of them can play, and each added track on its own.

import { audioIdSeededWith } from "@/lib/audio/upload"
import { slotSelections, type AudioAttachmentOut, type CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
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
