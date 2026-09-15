// AQU-464 — audio↔text drift.
//
// A recording is a snapshot of the text as it read WHEN THE MIC WAS ON. When
// the team makes a global wording change and hasn't re-recorded, the take and
// the line stop agreeing, and today nothing says so: the strip shows "Take 3"
// against text that take never spoke.
//
// The event log already answers this without a Paratext round-trip. A cell's
// `cell.audio.attach` and its `*.cell.commit`s live on the SAME
// `(project, file, cell)` log, so the commit that was winning immediately
// before the attach IS the text at time of recording, and the newest commit is
// the text now. Drift is the comparison.
//
// ORDERING IS BY `serverSeq`, NOT BY CLOCK. Both event kinds draw from one
// server-assigned sequence, so the ordering is exact; `clientTs` comes off the
// recorder's own device and a phone with a wrong clock would otherwise resolve
// a take against text written days later. `recordedAt` still carries the
// server timestamp because the human-facing question ("recorded when?") wants
// a date — it just never decides ordering.

import type { CellHistoryEvent } from "@/lib/sync/history-read-types"
import { computeOnChainSet } from "@/lib/sync/chain"

const COMMIT_KINDS = new Set(["target.cell.commit", "source.cell.commit"])
const ATTACH_KIND = "cell.audio.attach"

export interface RecordingTextDrift {
  audioId: string
  /** Server clock when the take was attached (ms epoch) — the "date stamp". */
  recordedAt: number
  /** The text as it stood when this take was recorded. Null when the take
   *  predates any commit on the cell (recorded before the line had text). */
  textAtRecording: string | null
  /** Commit event `textAtRecording` was read from — the "text revision" a
   *  recording is now associated with. */
  textAtRecordingEventId: string | null
  /** The text now. Null when the cell has no commit at all. */
  latestText: string | null
  latestTextEventId: string | null
  /**
   * The take was recorded against text that has since changed.
   *
   * True only when BOTH texts exist and differ by more than whitespace. A take
   * with nothing to drift from (no prior commit) is not drifted, and neither is
   * one whose text has not been touched since.
   */
  drifted: boolean
}

/** Whitespace-insensitive comparison: re-flowing a line is not a re-wording. */
function normalizeForDrift(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/**
 * The translatable text carried by a commit payload.
 *
 * Mirrors `useCellEditHistory`'s precedence deliberately: AQU-646 media source
 * cells carry their text as `transcription` and keep the import filename in
 * `value`, so reading `value` alone would compare a take against "luke-01.mp3".
 */
function commitText(event: CellHistoryEvent): string {
  const payload = event.payload as { value?: string; transcription?: string } | null
  return payload?.transcription ?? payload?.value ?? ""
}

function attachAudioId(event: CellHistoryEvent): string | null {
  const payload = event.payload as { audioId?: string } | null
  return payload?.audioId ?? null
}

const bySeqAsc = (a: CellHistoryEvent, b: CellHistoryEvent) => a.serverSeq - b.serverSeq

/**
 * When a take was recorded.
 *
 * The EARLIEST attach for an audioId wins. A take is re-attached after the
 * fact — Whisper word timings land ~800ms later on their own
 * `cell.audio.attach` — and resolving against the last one would date the
 * recording to whenever its transcription finished, quietly shifting a take
 * past a commit it was actually made before.
 */
function firstAttachFor(events: CellHistoryEvent[], audioId: string): CellHistoryEvent | null {
  const attaches = events
    .filter((e) => e.kind === ATTACH_KIND && attachAudioId(e) === audioId)
    .sort(bySeqAsc)
  return attaches[0] ?? null
}

export interface ResolveDriftOptions {
  /**
   * AD-2 chain head for this cell (the projection's current `event_id`).
   *
   * Stale siblings never advanced the projection, so they were never the text
   * anyone recorded against. Omit it and every commit counts — the same
   * fallback `useCellEditHistory` takes, and better than mis-reading a losing
   * branch as the line's history.
   */
  currentEventId?: string | null
}

/**
 * Resolve one take against the cell's text history.
 *
 * Returns null when the take has no attach event in `events` — the caller
 * handed us a clip from another cell, or the history window (server clamps to
 * 200) does not reach back to the attach. Both mean "cannot say", which must
 * not be rendered as "no drift".
 */
export function resolveRecordingTextDrift(
  events: CellHistoryEvent[],
  audioId: string,
  opts: ResolveDriftOptions = {},
): RecordingTextDrift | null {
  const attach = firstAttachFor(events, audioId)
  if (!attach) return null

  const onChain = computeOnChainSet(events, opts.currentEventId ?? null)
  const commits = events
    .filter((e) => COMMIT_KINDS.has(e.kind) && (onChain ? onChain.has(e.id) : true))
    .sort(bySeqAsc)

  // Strictly before the attach: a commit sharing the take's own seq window is
  // still text the recording could not have been made from.
  const priorCommits = commits.filter((e) => e.serverSeq < attach.serverSeq)
  const atRecording = priorCommits[priorCommits.length - 1] ?? null
  const latest = commits[commits.length - 1] ?? null

  const textAtRecording = atRecording ? commitText(atRecording) : null
  const latestText = latest ? commitText(latest) : null

  return {
    audioId,
    recordedAt: attach.serverTs,
    textAtRecording,
    textAtRecordingEventId: atRecording?.id ?? null,
    latestText,
    latestTextEventId: latest?.id ?? null,
    drifted:
      textAtRecording !== null &&
      latestText !== null &&
      normalizeForDrift(textAtRecording) !== normalizeForDrift(latestText),
  }
}

/**
 * Resolve many takes against one history read — the shape a takes strip wants.
 * Takes with no attach in `events` are absent from the map rather than present
 * and undrifted.
 */
export function resolveRecordingTextDriftMap(
  events: CellHistoryEvent[],
  audioIds: readonly string[],
  opts: ResolveDriftOptions = {},
): Map<string, RecordingTextDrift> {
  const out = new Map<string, RecordingTextDrift>()
  for (const audioId of audioIds) {
    const drift = resolveRecordingTextDrift(events, audioId, opts)
    if (drift) out.set(audioId, drift)
  }
  return out
}
