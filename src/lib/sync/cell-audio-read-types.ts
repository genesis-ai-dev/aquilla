// Client mirror of the sync-worker's GET /api/v1/projects/:p/files/:f/audio-attachments
// response (sync-worker/src/events/cell-audio-read-route.ts).

export interface AudioAttachmentOut {
  audioId: string
  url: string
  slot: "recording" | "generatedVoice"
  mimeType: string | null
  voiceId: string | null
  referenceAudioId: string | null
  durationMs: number | null
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
