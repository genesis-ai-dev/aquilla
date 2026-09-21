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
  // AQU-490. Optional so a caller that builds rows by hand (the client-side
  // contract test does) need not know about them; absent reads as an
  // unvalidated dub with no recorder, which is what every pre-0096 row is.
  validator_count?: number | null
  role?: string | null
  created_by?: string | null
  /** Who has validated THIS take, newest vote first. Joined in by the route. */
  validators?: string[]
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
  /**
   * AQU-490: how many people have validated this take, and who.
   *
   * The count is denormalized onto cell_audio and `validators` is joined from
   * cell_audio_validators, so the two always agree — but the COUNT is the one
   * to compare against a threshold. A viewer works out "have I validated
   * this?" by looking for themselves in `validators`; the server deliberately
   * does not send a per-viewer bit, because that would make this response
   * uncacheable across the people looking at the same file.
   */
  validatorCount: number
  validators: string[]
  /**
   * 'dub' — somebody's translation of this line. 'source' — the shared
   * programme audio an import attached, which sits SELECTED on every cell of a
   * media file and is therefore never counted, never validated, and never
   * auto-validated. See migration 0096.
   */
  role: "dub" | "source"
  /**
   * Who recorded it, for the self-validation rule. NULL is UNKNOWN — a take
   * whose attach event is gone, or a project the rollout has not reached — and
   * must never be treated as a match for the current viewer.
   */
  recordedBy: string | null
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
      // AQU-490. The defaults are the pre-0096 reading of a row: no votes, a
      // dub, no known recorder. `role` is narrowed rather than cast, so a
      // value the schema's CHECK could not produce still lands on 'dub' — the
      // safe side, since 'source' is what excludes a take from being counted.
      validatorCount: Number(r.validator_count ?? 0) || 0,
      validators: r.validators ?? [],
      role: r.role === "source" ? "source" : "dub",
      recordedBy: r.created_by ?? null,
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
