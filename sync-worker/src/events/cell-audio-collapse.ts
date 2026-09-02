// AQU-646: turning `cell_audio` rows into the per-cell shape the client reads.
//
// SPLIT OUT OF THE ROUTE, and not only for tidiness: this is the one piece of
// logic the client and the server have to agree about exactly — which slot a
// take is in, and which take in each slot is the active one — and the route
// around it needs a `AquillaDb` binding, an auth check and a `Request`. Pulling
// the HTTP handler into a client-side contract test would drag the worker's
// ambient globals into the client's build; this module is pure data in, pure
// data out, so both sides can import it.
//
// THE COLLAPSE IS WHERE A SELECTION CAN BE LOST. Before `selectedBySlot` it was
// an if/else over two slot literals with no fallthrough, so a take selected on
// an extra target-audio track arrived with its slot intact and was pointed at
// by nothing at all.

interface AudioRowRaw {
  cell_id: string
  audio_id: string
  slot: string
  url: string
  mime_type: string | null
  voice_id: string | null
  reference_audio_id: string | null
  duration_ms: number | null
  label: string | null
  trim_start_ms: number | null
  trim_end_ms: number | null
  target_offset_ms: number | null
  timings_json: string | null
  selected: number
  created_ts: number
}

export interface AttachmentOut {
  audioId: string
  url: string
  slot: string
  mimeType: string | null
  voiceId: string | null
  referenceAudioId: string | null
  durationMs: number | null
  /** AQU-646 round 8: the take's permanent display name. */
  label: string | null
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
  targetOffsetMs: number | null
}

export interface CellAudioOut {
  attachments: Record<string, AttachmentOut>
  /**
   * The active clip in EVERY slot, keyed by slot. (AQU-646 stage 3)
   *
   * THIS IS THE ONLY PLACE A SELECTION COULD BE LOST, and before this field it
   * was: the two named pointers below are an `if/else if` over two literals
   * with no fallthrough, so a row selected in any third slot arrived inside
   * `attachments` with its slot intact and was pointed at by nothing. Extra
   * target-audio tracks address their takes by their own track id, so that
   * third slot is now the normal case.
   */
  selectedBySlot: Record<string, string>
  /** Active clip in the "recording" slot. A PURE PROJECTION of the map above —
   *  kept because dozens of readers use it and it is the default track's whole
   *  contract, but derived rather than assigned so the two cannot drift. */
  selectedAudioId: string | null
  /** Active clip in the "generatedVoice" slot. Also a projection. */
  selectedGeneratedVoiceAudioId: string | null
  /** Whisper word timings by audioId. */
  audioTimings: Record<string, unknown>
}

export type { AudioRowRaw }

/** Fold the file's rows into the per-cell response body. */
export function collapseCellAudioRows(rows: readonly AudioRowRaw[]): Record<string, CellAudioOut> {
  const cells: Record<string, CellAudioOut> = {}
  for (const r of rows) {
    let entry = cells[r.cell_id]
    if (!entry) {
      entry = {
        attachments: {},
        selectedBySlot: {},
        selectedAudioId: null,
        selectedGeneratedVoiceAudioId: null,
        audioTimings: {},
      }
      cells[r.cell_id] = entry
    }
    entry.attachments[r.audio_id] = {
      audioId: r.audio_id,
      url: r.url,
      slot: r.slot,
      mimeType: r.mime_type,
      voiceId: r.voice_id,
      referenceAudioId: r.reference_audio_id,
      durationMs: r.duration_ms,
      label: r.label,
      trimStartMs: r.trim_start_ms,
      trimEndMs: r.trim_end_ms,
      targetOffsetMs: r.target_offset_ms,
    }
    if (r.timings_json) {
      try {
        entry.audioTimings[r.audio_id] = JSON.parse(r.timings_json)
      } catch {
        // ignore malformed timings — playback degrades to no karaoke
      }
    }
    if (r.selected === 1) entry.selectedBySlot[r.slot] = r.audio_id
  }

  // The two named pointers, derived from the map rather than written beside it.
  // Assigning them in the loop above is what let the two shapes disagree; a
  // projection cannot.
  for (const entry of Object.values(cells)) {
    entry.selectedAudioId = entry.selectedBySlot["recording"] ?? null
    entry.selectedGeneratedVoiceAudioId = entry.selectedBySlot["generatedVoice"] ?? null
  }

  return cells
}
