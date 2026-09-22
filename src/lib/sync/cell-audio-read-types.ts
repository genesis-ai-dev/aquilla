// Client mirror of the sync-worker's GET /api/v1/projects/:p/files/:f/audio-attachments
// response (apps/sync/src/events/cell-audio-read-route.ts).

import { GENERATED_VOICE_SLOT, RECORDING_SLOT } from "@/lib/timeline/track-slots"

export interface AudioAttachmentOut {
  audioId: string
  url: string
  /** AQU-646: an OPEN string, matching the server's own type for this field.
   *  `cell_audio.slot` is unconstrained TEXT; an extra target-audio track
   *  addresses its takes by its own track id. Well-known: "recording",
   *  "generatedVoice". */
  slot: string
  mimeType: string | null
  voiceId: string | null
  referenceAudioId: string | null
  durationMs: number | null
  /** AQU-646 round 8: the take's PERMANENT display name ("Take 3" or a user
   *  rename). Never derived from list position; null on legacy takes until
   *  the strip backfills. */
  label?: string | null
  /** Non-destructive playback trim window into the clip, in ms (null = clip edge). */
  trimStartMs: number | null
  trimEndMs: number | null
  /**
   * AQU-646 stage 3: where this take sits against its line, in ms from the
   * line's own start. Negative is legal (a take that leads its line) and `0` is
   * a real placement.
   *
   * NULL MEANS "NEVER PLACED BY HAND", not "placed at zero" — readers fall back
   * to the cell's own `target_offset_ms`, which stays the permanent home for
   * every take made before this column existed.
   */
  targetOffsetMs?: number | null
  /** SUB-48: set by the optimistic overlay while this clip's event is still
   *  sitting in the outbox — i.e. saved on this device but not yet at the
   *  server. Never sent by the server; UI renders a "saving…" hint from it so
   *  a queued take is visibly safe rather than mysteriously present. */
  pendingSync?: true
  /** AQU-924: set by the optimistic overlay when this clip's attach event was
   *  QUARANTINED (403) or exhausted its retry budget. The clip's bytes are in
   *  R2 and the event is still durable in the outbox, but the server has no
   *  attachment for it and won't get one without user action. Never sent by the
   *  server. The overlay deliberately keeps painting the take so it can be seen
   *  and retried — dropping it was silent data loss (the take vanished on the
   *  next read, and again on reload). Mutually exclusive with `pendingSync`. */
  syncFailed?: true
  /**
   * AQU-490: how many people have validated THIS take, and who.
   *
   * Both OPTIONAL, for the reason `selectedBySlot` is: a client running
   * against a worker that predates them must read as "nobody has validated
   * anything" rather than as a crash or an empty take list. Absent is the
   * pre-AQU-490 state, which is what every number in the product said anyway.
   *
   * The COUNT is what gets compared to the project's threshold. `validators`
   * is for the hover list and for working out whether the current viewer is
   * among them — the server sends no per-viewer bit on purpose, so that one
   * response stays valid for everyone reading the same file.
   */
  validatorCount?: number
  validators?: string[]
  /**
   * 'dub' is somebody's translation of this line. 'source' is the shared
   * programme audio an import attached — it sits SELECTED in the recording
   * slot on every cell of a media file, so "selected" alone can never mean "a
   * dub exists here". Absent reads as 'dub', matching every pre-0096 row.
   */
  role?: "dub" | "source"
  /**
   * Who recorded it, for the self-validation rule. NULL/absent is UNKNOWN and
   * must never be treated as a match for the current viewer — a take whose
   * attach event is gone would otherwise become unvalidatable by everybody on
   * a project with self-validation off.
   */
  recordedBy?: string | null
}

/** A take counts toward validation only if somebody dubbed it. */
export function isDubTake(att: Pick<AudioAttachmentOut, "role">): boolean {
  return (att.role ?? "dub") === "dub"
}

/** Votes on one take, tolerating a worker that predates the field. */
export function takeValidatorCount(att: Pick<AudioAttachmentOut, "validatorCount">): number {
  return Math.max(0, Number(att.validatorCount ?? 0) || 0)
}

/** Has `username` validated this take? A blank username is never a match. */
export function hasValidatedTake(
  att: Pick<AudioAttachmentOut, "validators">,
  username: string,
): boolean {
  if (!username) return false
  return (att.validators ?? []).includes(username)
}

export interface CellAudioEntry {
  attachments: Record<string, AudioAttachmentOut>
  /**
   * The active clip in EVERY slot, keyed by slot. (AQU-646 stage 3)
   *
   * Extra target-audio tracks address their takes by their own track id, so the
   * two named pointers below cannot express a selection on one. They remain as
   * PURE PROJECTIONS of this map — the server derives them from it rather than
   * assigning them alongside, which is what stops the two shapes drifting.
   *
   * OPTIONAL, and deliberately so: a client running against a worker that
   * predates this field still gets the two pointers, and `slotSelections()`
   * rebuilds the map from them. Requiring it would make a version skew during
   * a rollout look like every take vanishing.
   */
  selectedBySlot?: Record<string, string>
  /** Active clip in the "recording" slot. A projection of `selectedBySlot`. */
  selectedAudioId: string | null
  /** Active clip in the "generatedVoice" slot. Also a projection. */
  selectedGeneratedVoiceAudioId: string | null
  /** Whisper word timings by audioId. */
  audioTimings: Record<string, unknown>
}

export interface FileAudioAttachmentsResponse {
  cells: Record<string, CellAudioEntry>
}

/**
 * A cell's selections keyed by slot, however the server chose to express them.
 *
 * Prefers the map; falls back to rebuilding one from the two named pointers,
 * which is what a worker predating `selectedBySlot` sends. Callers get one
 * shape and never have to know which they were handed.
 */
export function slotSelections(
  entry: Pick<CellAudioEntry, "selectedBySlot" | "selectedAudioId" | "selectedGeneratedVoiceAudioId">,
): Record<string, string> {
  if (entry.selectedBySlot) return entry.selectedBySlot
  const rebuilt: Record<string, string> = {}
  if (entry.selectedAudioId) rebuilt["recording"] = entry.selectedAudioId
  if (entry.selectedGeneratedVoiceAudioId) rebuilt["generatedVoice"] = entry.selectedGeneratedVoiceAudioId
  return rebuilt
}

/**
 * AQU-490: the takes a cell's audio validation is measured over — the selected
 * one in every slot, minus the imported source clip.
 *
 * ONE definition, because five surfaces ask this question (the gutter, the
 * take block, the recorder's take list, the timeline chip, the voice panel)
 * and the server asks it again in SQL. If any of them derived it differently,
 * the editor and the plan board would disagree about the same line.
 */
export function selectedDubTakes(entry: CellAudioEntry): AudioAttachmentOut[] {
  const selections = slotSelections(entry)
  const dubAt = (slot: string): AudioAttachmentOut | undefined => {
    const audioId = selections[slot]
    if (!audioId) return undefined
    const att = entry.attachments[audioId]
    return att && isDubTake(att) ? att : undefined
  }

  const out: AudioAttachmentOut[] = []
  // Keyed by audioId, because the same take appearing under two slots would
  // otherwise be counted twice: the fraction's denominator would double, a
  // click would emit the same vote twice, and the popover would render a
  // duplicate key. No producer does that today — the server keeps one
  // selection per slot — but the optimistic overlay writes a take's new slot
  // without clearing its old one, which is one slot-move away from it
  // (adversarial review, 2026-09-22).
  const seen = new Set<string>()
  const push = (att: AudioAttachmentOut) => {
    if (seen.has(att.audioId)) return
    seen.add(att.audioId)
    out.push(att)
  }
  for (const slot of Object.keys(selections)) {
    // The two default-track slots are handled together below.
    if (slot === RECORDING_SLOT || slot === GENERATED_VOICE_SLOT) continue
    const att = dubAt(slot)
    if (att) push(att)
  }

  // ONE TAKE PER TRACK, and the default track is the only one that needs
  // saying so: it owns TWO slots, `recording` and `generatedVoice`, while
  // every added track owns exactly one. Only one of the two ever sounds —
  // `resolveTargetAudio` prefers the recording slot and falls through to the
  // voice — so counting both made a line with a real take AND a leftover
  // generated voice ask to be validated twice on one track. Sam hit it on a
  // two-track line reading "of 3" with only two chips to show for it
  // (2026-09-21). This is that resolution restated over the read shape, which
  // is what keeps the two from drifting.
  const defaultTrack = dubAt(RECORDING_SLOT) ?? dubAt(GENERATED_VOICE_SLOT)
  if (defaultTrack) push(defaultTrack)
  return out
}

/**
 * How validated a cell's audio is: the MINIMUM vote count across its selected
 * dub takes, or null when it has none.
 *
 * The minimum is Sam's rule — every track holding a selected take must be
 * validated — reduced to one number, so "is this cell done at N?" is a single
 * comparison. It is also exactly what the server buckets into the progress
 * histogram, so the gutter and the board cannot disagree.
 *
 * NULL MEANS NOT RECORDED, which is a different state from recorded and
 * unvalidated. Returning 0 for it would make an empty line indistinguishable
 * from one nobody has listened to yet, and would put cells in the denominator
 * that can never reach the numerator.
 */
export function cellAudioVotes(entry: CellAudioEntry): number | null {
  const takes = selectedDubTakes(entry)
  if (takes.length === 0) return null
  let min = Infinity
  for (const take of takes) min = Math.min(min, takeValidatorCount(take))
  return min
}

/** Is this cell's audio validated at `threshold`? False when not recorded. */
export function isCellAudioValidated(entry: CellAudioEntry, threshold: number): boolean {
  const votes = cellAudioVotes(entry)
  return votes != null && votes >= Math.max(1, threshold)
}
