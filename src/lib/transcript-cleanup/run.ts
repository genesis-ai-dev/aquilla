// The Transcribe lens's two steps (spec §3). `transcribeRow` is ASR alone —
// what "Transcribe all" runs. `transcribeAndCleanUp` is the cleanup a person
// asks for on one or more rows: ASR first when the clip has no saved ASR text,
// then an LLM cleanup taught by the lane's own corrections, landed as an AI
// cleanup. Neither throws: the row shows the outcome, and a failure names the
// step that failed and is reported to error tracking (it used to read
// "Couldn't clean up" for any step, and an ASR error read "No speech heard").
//
// Both report as they go (`onProgress`), so the row is never a bare spinner:
// what ASR heard is handed over the moment it arrives, before it is saved and
// read back, and the cleanup is handed over as the model writes it.

import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { Concept } from "@/lib/terminology/types"
import type { WordTiming } from "@/lib/codex-editor/types"
import type { CorrectionRule } from "@/lib/audio/transcript-corrections"
import type { CellData } from "@/hooks/useCells"
import type { TranscriptionModel } from "@/lib/audio/transcription-model"
import { AUTH_BASE } from "@/lib/frontier/auth"
import { aiRefusalError } from "@/lib/billing/ai-refusal"
import posthog from "@/lib/posthog"
import { transcribeCell } from "@/lib/audio/transcribe"
import { getTranscribeStatus } from "@/lib/audio/transcribe-status"
import { laneLanguageForTag } from "@/lib/lanes/lane-language"
import { laneLanguage } from "@/lib/lanes/lane-display"
import type { CleanupInput, CleanupParse } from "./prompt"
import {
  cleanupTerms, neighbourTranscripts, pickCleanupPairs, pickCorrectedOnly, pickWritingSamples, type TranscriptRow,
} from "./rows"
import { saveTranscript } from "./save"
import { readCleanupReply } from "./stream"

export const TRANSCRIPT_CLEANUP_URL = `${AUTH_BASE}/api/v1/ai/transcript-cleanup`

/** Which step a failure happened in: speech recognition, the AI cleanup, or the save. */
export type FailedStep = "asr" | "cleanup" | "save"

/** Where a running row has got to. Each carries what there is to show. */
export type RowProgress =
  /** Speech recognition is running (or its model is still waking up). */
  | { stage: "listening" }
  /** Speech recognition answered: show it now, the save is still on its way. */
  | { stage: "heard"; heard: string; transcript: string }
  /** The cleanup is being written. `text` is the reply so far. */
  | { stage: "cleaning"; heard: string; text: string }

export type SparkleOutcome =
  | { kind: "cleaned"; changes: number; text: string }
  | { kind: "transcribed" }
  | { kind: "unchanged" }
  /** The cleanup changed nothing AND had nothing to go on: no corrected
   *  transcript, no written line, no key term. "Nothing to clean up" would be
   *  a claim the model was in no position to make. */
  | { kind: "unlearned" }
  | { kind: "too-different" }
  | { kind: "no-speech" }
  | { kind: "validated" }
  | { kind: "allowance" }
  | { kind: "failed"; step: FailedStep; detail?: string }

function failed(analytics: ReturnType<typeof posthog.scope>, step: FailedStep, projectId: string, detail?: string): SparkleOutcome {
  analytics.captureException(new Error(`Transcribe lens ${step} failed${detail ? `: ${detail}` : ""}`), {
    transcribe_step: step,
    project_id: projectId,
  })
  return { kind: "failed", step, ...(detail ? { detail } : {}) }
}

/** The ASR language follows the AUDIO, by provenance: an imported source
 *  segment is source speech, a take voices its lane (as CellTakeBlock does). */
export function rowLanguage(project: ProjectRecord, row: TranscriptRow, targetLang: string | undefined): string | undefined {
  if (row.isSourceSegment) {
    const sourceLane = project.lanes?.find((lane) => lane.role === "source")
    return laneLanguage(sourceLane ?? { role: "source" }, {
      role: "source",
      legacyTag: sourceLane?.legacyTag ?? null,
    }) ?? undefined
  }
  return laneLanguageForTag(targetLang ?? "", project.lanes) ?? undefined
}

async function requestCleanup(
  body: CleanupInput & { projectId: string },
  token: string,
  onText?: (text: string) => void,
): Promise<{ ok: true; model: string; result: CleanupParse } | { ok: false; reason: "allowance" } | { ok: false; reason: "failed"; detail: string }> {
  try {
    const res = await fetch(TRANSCRIPT_CLEANUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ ...body, stream: true }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return aiRefusalError(res.status, text)
        ? { ok: false, reason: "allowance" }
        : { ok: false, reason: "failed", detail: `${res.status} ${text.slice(0, 200)}`.trim() }
    }
    const out = await readCleanupReply(res, onText)
    if (!out.result || typeof out.result.kind !== "string") return { ok: false, reason: "failed", detail: "unreadable reply" }
    return { ok: true, model: out.model ?? "unknown", result: out.result }
  } catch (err) {
    return { ok: false, reason: "failed", detail: err instanceof Error ? err.message : String(err) }
  }
}

/** The Transcribe lens's own model choice for a run (TranscribeEditor's
 *  Fast / Smart picker), in place of the account's Preferences choice. */
export interface RowModelChoice {
  model: TranscriptionModel
  /** Zero-shot only: what to run, without asking, when zero-shot cannot. */
  quietFallback?: TranscriptionModel
}

interface RowArgs {
  row: TranscriptRow
  project: ProjectRecord
  session: FrontierSession
  targetLang?: string
  /** A batch waits out the per-user limit; one row reports it as a failure. */
  onRateLimited?: (retryAfterSeconds: number) => Promise<void>
  onProgress?: (progress: RowProgress) => void
  speech?: RowModelChoice
}

type Heard = { kind: "heard"; heard: string; transcript: string; timings: WordTiming[] }

/** Run ASR on the row's clip and save what it heard. */
async function runAsr(args: RowArgs): Promise<Heard | SparkleOutcome> {
  const analytics = posthog.scope(undefined, args.session.username)
  const { row, project, session, targetLang, onRateLimited, onProgress, speech } = args
  const attachment = row.cell.attachments?.[row.audioId]
  if (!attachment) return failed(analytics, "asr", project.id, "no clip")
  let got: { heard: string; transcript: string; timings: WordTiming[] } | null = null
  onProgress?.({ stage: "listening" })
  try {
    await transcribeCell({
      cell: { ...row.cell, selectedAudioId: row.audioId },
      slot: attachment.slot,
      session,
      projectId: project.id,
      language: rowLanguage(project, row, targetLang),
      ...(targetLang && !row.isSourceSegment ? { targetLang } : {}),
      askAgain: true,
      ...(onRateLimited ? { onRateLimited } : {}),
      ...(speech ? { hostedModel: speech.model } : {}),
      ...(speech?.quietFallback ? { hostedQuietFallback: speech.quietFallback } : {}),
      onTranscribed: (r) => {
        got = r
        // Now, not when transcribeCell resolves: the words are here, and the
        // row should show them while the save is still being queued.
        if (r.transcript && r.timings.length > 0) onProgress?.({ stage: "heard", heard: r.heard, transcript: r.transcript })
      },
    })
  } catch (err) {
    return failed(analytics, "asr", project.id, err instanceof Error ? err.message : String(err))
  }
  const result = got as { heard: string; transcript: string; timings: WordTiming[] } | null
  if (!result) {
    // transcribeCell never throws: it keeps the error in the status store.
    const status = getTranscribeStatus(row.audioId)
    return status.kind === "error" ? failed(analytics, "asr", project.id, status.message) : { kind: "no-speech" }
  }
  if (!result.transcript || result.timings.length === 0) return { kind: "no-speech" }
  return { kind: "heard", ...result }
}

/** "Transcribe all": ASR only. The cleanup stays a person's choice, per row. */
export async function transcribeRow(args: RowArgs): Promise<SparkleOutcome> {
  if (args.row.validated) return { kind: "validated" }
  const heard = await runAsr(args)
  return heard.kind === "heard" ? { kind: "transcribed" } : heard
}

export async function transcribeAndCleanUp(args: {
  row: TranscriptRow
  rows: readonly TranscriptRow[]
  /** Every cell of the file, in order: where the written lines that show the
   *  cleanup this language's spelling come from (`pickWritingSamples`). */
  cells?: readonly CellData[]
  project: ProjectRecord
  session: FrontierSession
  targetLang?: string
  concepts: readonly Concept[]
  learned: readonly CorrectionRule[]
  /** Re-run ASR even when the clip already has saved ASR text. */
  forceAsr?: boolean
  onProgress?: (progress: RowProgress) => void
  speech?: RowModelChoice
}): Promise<SparkleOutcome> {
  const analytics = posthog.scope(undefined, args.session.username)
  const { row, project, session, targetLang } = args
  if (row.validated) return { kind: "validated" }
  const attachment = row.cell.attachments?.[row.audioId]
  if (!attachment) return failed(analytics, "asr", project.id, "no clip")
  const language = rowLanguage(project, row, targetLang)

  // Step 1: ASR, unless what it heard is already saved and still transcribed.
  let heard = row.heard
  let transcript = row.transcript
  let timings: readonly WordTiming[] = row.cell.audioTimings?.[row.audioId] ?? []
  if (args.forceAsr || !heard || !transcript || timings.length === 0) {
    const result = await runAsr({
      row, project, session, ...(targetLang ? { targetLang } : {}),
      ...(args.onProgress ? { onProgress: args.onProgress } : {}),
      ...(args.speech ? { speech: args.speech } : {}),
    })
    if (result.kind !== "heard") return result
    heard = result.heard
    transcript = result.transcript
    timings = result.timings
  }

  // Step 2: the cleanup. The text sent is the stored transcript (what ASR
  // heard, with the learned word fixes applied); pairs are ranked by the raw
  // heard text, which is what the examples' own `heard` sides are.
  const shown = heard ?? transcript
  args.onProgress?.({ stage: "cleaning", heard: shown, text: "" })
  const input: CleanupInput & { projectId: string } = {
    projectId: project.id,
    heard: transcript,
    language: language ?? null,
    pairs: pickCleanupPairs(args.rows, row, heard ?? transcript, args.learned),
    correctedOnly: pickCorrectedOnly(args.rows, row),
    terms: cleanupTerms(args.concepts, row.isSourceSegment),
    context: neighbourTranscripts(args.rows, row),
    samples: pickWritingSamples(args.cells ?? [], row),
  }
  const cleaned = await requestCleanup(input, session.jwt, (text) => {
    args.onProgress?.({ stage: "cleaning", heard: shown, text })
  })
  if (!cleaned.ok) return cleaned.reason === "allowance" ? { kind: "allowance" } : failed(analytics, "cleanup", project.id, cleaned.detail)
  const result = cleaned.result
  if (result.kind === "unchanged") {
    const evidence = input.pairs.length + input.correctedOnly.length + input.terms.length + (input.samples?.length ?? 0)
    return { kind: evidence > 0 ? "unchanged" : "unlearned" }
  }
  if (result.kind === "too-different") return { kind: "too-different" }
  if (result.kind !== "ok") return failed(analytics, "cleanup", project.id, `result ${result.kind}`)

  // Step 3: land it as an AI cleanup — timings remapped, the mark set.
  try {
    const saved = await saveTranscript({
      projectId: project.id,
      owner: row.cell,
      audioId: row.audioId,
      attachment,
      timings,
      text: result.text,
      ...(targetLang && !row.isSourceSegment ? { targetLang } : {}),
      author: session.username,
      ai: { model: cleaned.model, at: Date.now(), changes: result.changes },
    })
    return saved ? { kind: "cleaned", changes: result.changes, text: result.text } : failed(analytics, "save", project.id, "no timings to save onto")
  } catch (err) {
    return failed(analytics, "save", project.id, err instanceof Error ? err.message : String(err))
  }
}
