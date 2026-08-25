// AQU-646 stage 3: which storage slot a timeline track's takes live in.
//
// `cell_audio.slot` is unconstrained TEXT, and selection is already `selected =
// 1` per `(cell_id, slot)` in SQL — the projection's attach deselects that
// slot's siblings and nothing else. That per-slot rule is the entire mechanism
// this stage needs; nothing about the database changes.
//
// ── ONE SLOT PER ADDED TRACK, NOT TWO ────────────────────────────────────────
//
// The obvious scheme is two slots per track, mirroring the default row's
// `recording` + `generatedVoice`. It is the wrong shape, and the reason is a
// piece of machinery that exists twice in the app: the SLOT JUGGLE. Because
// `resolveTargetAudio` prefers whatever holds `"recording"`, activating a
// generated voice has to shove the recording slot back onto the shared imported
// source clip so the voice can be heard (AudioRecordingModal and TakesStrip
// both do this). An added track has no shared source clip, so there is nothing
// to shove it onto and the trick cannot be repeated.
//
// So an added track gets ONE slot holding every take on it, recorded and
// generated alike. Selection being per-(cell, slot) then gives exactly one
// sounding take per track per line for free, using the deselect the server
// already performs — a recorded take and a generated voice on one track are
// siblings in one list, and picking either deselects the other. No juggling
// anywhere.
//
// What a take IS, rather than where it lives, comes off the attachment:
// `voiceId` is set unconditionally by all three paths that mint a generated
// voice (generate-voice.ts's two branches and combined-voice.ts), so it is a
// sound "this one is synthetic" test on any slot. That is what the chip's tone
// and its sparkle read.
//
// ── THE DEFAULT TRACK NEVER MOVES ────────────────────────────────────────────
//
// `target-audio` keeps `"recording"` and `"generatedVoice"` forever. Every
// existing take stays exactly where it is, and every surface that reads
// `selectedAudioId` — export, TTS, progress, the rollups — keeps working
// untouched. Extra tracks are purely additive.
//
// Nothing is ever migrated, and could not usefully be: attach assigns
// `slot = excluded.slot` outright and `rebuild.ts` replays history, so a
// backfilled value would be rewritten by the next replay anyway.

/** The default target-audio track's id — its slots are the two legacy names. */
export const DEFAULT_TARGET_TRACK_ID = "target-audio"

/** A recorded take on the default track. */
export const RECORDING_SLOT = "recording"
/** A generated voice on the default track. */
export const GENERATED_VOICE_SLOT = "generatedVoice"

/**
 * The slot a track's takes are stored in.
 *
 * Added tracks use their own id, which cannot collide with the two well-known
 * names: track ids are uuidv7, and the server's `TRACK_ID_PATTERN` would not
 * accept a camel-case word as a generated id in the first place.
 */
export function slotForTrack(trackId: string): string {
  return trackId === DEFAULT_TARGET_TRACK_ID ? RECORDING_SLOT : trackId
}

/** Is this one of the default track's two slots? */
export function isDefaultTrackSlot(slot: string): boolean {
  return slot === RECORDING_SLOT || slot === GENERATED_VOICE_SLOT
}

/**
 * Which track a slot belongs to — the inverse of `slotForTrack`, plus the
 * generated-voice slot, which maps to the same track as the recording one.
 *
 * Used to group a cell's takes by track in the Recording tab.
 */
export function trackIdForSlot(slot: string): string {
  return isDefaultTrackSlot(slot) ? DEFAULT_TARGET_TRACK_ID : slot
}

/**
 * Every slot that belongs to a track, for readers that must cover both of the
 * default track's.
 *
 * Order matters and is the resolution order: a recorded take outranks a
 * generated voice on the default track, which is the behaviour that has always
 * shipped. An added track has one slot, so there is nothing to rank.
 */
export function slotsForTrack(trackId: string): string[] {
  return trackId === DEFAULT_TARGET_TRACK_ID
    ? [RECORDING_SLOT, GENERATED_VOICE_SLOT]
    : [trackId]
}

/**
 * Is this track's audio on?
 *
 * LIVES HERE, in the leaf, rather than beside the audibility state it reads.
 * Three modules need it — the queue's mute sweep, the persistence layer and the
 * gutter's speaker button — and the two obvious homes are both mocked in tests
 * (`play-queue`) or would close a cycle with the one that is (`audibility`). A
 * structural parameter keeps this module free of both.
 *
 * The default row answers from `target`, the flag it has always used. An added
 * track answers from its own, and ABSENT MEANS AUDIBLE: a brand-new track is
 * heard without anybody opting in, and a flag can only be there because someone
 * switched it off.
 */
export function slotAudible(
  state: { target: boolean; bySlot?: Record<string, boolean> },
  slot: string,
): boolean {
  if (isDefaultTrackSlot(slot)) return state.target
  return state.bySlot?.[slot] !== false
}
