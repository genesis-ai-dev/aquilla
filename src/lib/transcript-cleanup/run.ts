// The Transcribe lens's sparkle: ASR when the clip has no saved ASR text,
// then an LLM cleanup taught by the lane's own corrections, landed as an AI
// cleanup (spec §3). Never throws: the row shows the outcome.

import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { Concept } from "@/lib/terminology/types"
import type { WordTiming } from "@/lib/codex-editor/types"
import type { CorrectionRule } from "@/lib/audio/transcript-corrections"
import { AUTH_BASE } from "@/lib/frontier/auth"
import { aiRefusalError } from "@/lib/billing/ai-refusal"
import { transcribeCell } from "@/lib/audio/transcribe"
import { laneLanguageForTag } from "@/lib/lanes/lane-language"
import { laneLanguage } from "@/lib/lanes/lane-display"
import type { CleanupInput, CleanupParse } from "./prompt"
import { cleanupTerms, neighbourTranscripts, pickCleanupPairs, pickCorrectedOnly, type TranscriptRow } from "./rows"
import { saveTranscript } from "./save"

export const TRANSCRIPT_CLEANUP_URL = `${AUTH_BASE}/api/v1/ai/transcript-cleanup`

export type SparkleOutcome =
  | { kind: "cleaned"; changes: number }
  | { kind: "unchanged" }
  | { kind: "too-different" }
  | { kind: "no-speech" }
  | { kind: "validated" }
  | { kind: "allowance" }
  | { kind: "failed" }

/** The ASR language follows the AUDIO, by provenance: an imported source
 *  segment is source speech, a take voices its lane (as CellTakeBlock does). */
export function rowLanguage(project: ProjectRecord, row: TranscriptRow, targetLang: string | undefined): string | undefined {
  if (row.isSourceSegment) {
    const sourceLane = project.lanes?.find((lane) => lane.role === "source")
    return laneLanguage(sourceLane ?? { role: "source" }, {
      settings: project,
      role: "source",
      legacyTag: sourceLane?.legacyTag ?? null,
    }) ?? undefined
  }
  return laneLanguageForTag(targetLang ?? "", project.lanes, project) ?? undefined
}

async function requestCleanup(
  body: CleanupInput & { projectId: string },
  token: string,
): Promise<{ ok: true; model: string; result: CleanupParse } | { ok: false; reason: "allowance" | "failed" }> {
  try {
    const res = await fetch(TRANSCRIPT_CLEANUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return aiRefusalError(res.status, await res.text().catch(() => "")) ? { ok: false, reason: "allowance" } : { ok: false, reason: "failed" }
    }
    const out = (await res.json()) as { model?: string; result?: CleanupParse }
    if (!out.result || typeof out.result.kind !== "string") return { ok: false, reason: "failed" }
    return { ok: true, model: out.model ?? "unknown", result: out.result }
  } catch {
    return { ok: false, reason: "failed" }
  }
}

export async function transcribeAndCleanUp(args: {
  row: TranscriptRow
  rows: readonly TranscriptRow[]
  project: ProjectRecord
  session: FrontierSession
  targetLang?: string
  concepts: readonly Concept[]
  learned: readonly CorrectionRule[]
  /** Re-run ASR even when the clip already has saved ASR text. */
  forceAsr?: boolean
}): Promise<SparkleOutcome> {
  const { row, project, session, targetLang } = args
  if (row.validated) return { kind: "validated" }
  const attachment = row.cell.attachments?.[row.audioId]
  if (!attachment) return { kind: "failed" }
  const language = rowLanguage(project, row, targetLang)

  // Step 1: ASR, unless what it heard is already saved and still transcribed.
  let heard = row.heard
  let transcript = row.transcript
  let timings: readonly WordTiming[] = row.cell.audioTimings?.[row.audioId] ?? []
  if (args.forceAsr || !heard || !transcript || timings.length === 0) {
    let got: { heard: string; transcript: string; timings: WordTiming[] } | null = null
    try {
      await transcribeCell({
        cell: { ...row.cell, selectedAudioId: row.audioId },
        slot: attachment.slot,
        session,
        projectId: project.id,
        language,
        ...(targetLang && !row.isSourceSegment ? { targetLang } : {}),
        askAgain: true,
        onTranscribed: (r) => { got = r },
      })
    } catch (err) {
      console.warn("[transcript-cleanup] transcription failed:", err)
      return { kind: "failed" }
    }
    const result = got as { heard: string; transcript: string; timings: WordTiming[] } | null
    if (!result || !result.transcript || result.timings.length === 0) return { kind: "no-speech" }
    heard = result.heard
    transcript = result.transcript
    timings = result.timings
  }

  // Step 2: the cleanup. The text sent is the stored transcript (what ASR
  // heard, with the learned word fixes applied); pairs are ranked by the raw
  // heard text, which is what the examples' own `heard` sides are.
  const cleaned = await requestCleanup({
    projectId: project.id,
    heard: transcript,
    language: language ?? null,
    pairs: pickCleanupPairs(args.rows, row, heard ?? transcript, args.learned),
    correctedOnly: pickCorrectedOnly(args.rows, row),
    terms: cleanupTerms(args.concepts, row.isSourceSegment),
    context: neighbourTranscripts(args.rows, row),
  }, session.jwt)
  if (!cleaned.ok) return { kind: cleaned.reason }
  const result = cleaned.result
  if (result.kind === "unchanged" || result.kind === "too-different") return { kind: result.kind }
  if (result.kind !== "ok") return { kind: "failed" }

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
    return saved ? { kind: "cleaned", changes: result.changes } : { kind: "failed" }
  } catch (err) {
    console.warn("[transcript-cleanup] save failed:", err)
    return { kind: "failed" }
  }
}
