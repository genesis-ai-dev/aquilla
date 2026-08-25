// Client mirror of the sync-worker's GET /api/v1/projects/:p/files/:f/audio-attachments
// response (apps/sync/src/events/cell-audio-read-route.ts).

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
