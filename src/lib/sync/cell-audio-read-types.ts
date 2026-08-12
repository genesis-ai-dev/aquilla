// Client mirror of the sync-worker's GET /api/v1/projects/:p/files/:f/audio-attachments
// response (apps/sync/src/events/cell-audio-read-route.ts).

export interface AudioAttachmentOut {
  audioId: string
  url: string
  slot: "recording" | "generatedVoice"
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
  /** SUB-48: set by the optimistic overlay while this clip's event is still
   *  sitting in the outbox — i.e. saved on this device but not yet at the
   *  server. Never sent by the server; UI renders a "saving…" hint from it so
   *  a queued take is visibly safe rather than mysteriously present. */
  pendingSync?: true
}

export interface CellAudioEntry {
  attachments: Record<string, AudioAttachmentOut>
  /** Active clip in the "recording" slot. */
  selectedAudioId: string | null
  /** Active clip in the "generatedVoice" slot. */
  selectedGeneratedVoiceAudioId: string | null
  /** Whisper word timings by audioId. */
  audioTimings: Record<string, unknown>
}

export interface FileAudioAttachmentsResponse {
  cells: Record<string, CellAudioEntry>
}
