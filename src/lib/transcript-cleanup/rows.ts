// The Transcribe lens's view of a cell, and the examples the cleanup learns
// from (docs/superpowers/specs/2026-10-23-transcript-cleanup-design.md §2–3).
//
// A row is a cell with a selected clip. Which transcript it edits follows the
// clip's provenance: an imported source segment's transcript is the cell's
// source `transcription` (source language); a recorded take's transcript is
// its word timings (that lane's language).

import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import { isSourceSegmentSelected } from "@/lib/audio/batch-audio"
import { applyCorrections, type CorrectionRule } from "@/lib/audio/transcript-corrections"
import { CLEANUP_MAX_PAIRS, CLEANUP_MAX_TERMS, type CleanupPair } from "./prompt"

export interface TranscriptRow {
  cell: CellData
  audioId: string
  isSourceSegment: boolean
  /** What ASR heard (attachment.asrText), or null when never saved. */
  heard: string | null
  /** The transcript as it reads now. Empty when not transcribed yet. */
  transcript: string
  /** The transcript is still the AI's cleanup (no human edit since). */
  aiCleaned: boolean
  /** The take has at least one validation vote. Cleanup never touches it. */
  validated: boolean
}

const loose = (s: string): string =>
  s.toLowerCase().replace(/[\p{P}\p{S}]/gu, "").trim().split(/\s+/).filter(Boolean).join(" ")

export function transcriptRowOf(cell: CellData): TranscriptRow | null {
  const audioId = cell.selectedAudioId
  if (!audioId) return null
  const attachment = cell.attachments?.[audioId]
  if (!attachment || attachment.isDeleted) return null
  const isSourceSegment = isSourceSegmentSelected(cell)
  const timings = cell.audioTimings?.[audioId] ?? []
  const fromTimings = timings.map((t) => t.word).join(" ").trim()
  const transcript = isSourceSegment ? (cell.transcription?.trim() || fromTimings) : fromTimings
  return {
    cell,
    audioId,
    isSourceSegment,
    heard: attachment.asrText?.trim() || null,
    transcript,
    aiCleaned: Boolean(attachment.transcriptAi),
    validated: (attachment.validatorCount ?? 0) > 0,
  }
}

/**
 * A person settled on this transcript: it differs from what ASR heard after
 * the learned word fixes were applied (which is what transcription stores), and
 * it is not an AI cleanup still waiting for review.
 */
export function isHumanCorrected(row: TranscriptRow, learned: readonly CorrectionRule[]): boolean {
  if (row.aiCleaned || !row.heard || !row.transcript) return false
  return loose(row.transcript) !== loose(applyCorrections(row.heard, learned))
}

const wordSet = (s: string): Set<string> => new Set(loose(s).split(" ").filter(Boolean))

/**
 * The lane's heard → corrected pairs, most similar to `heard` first (shared
 * words), one per distinct correction. Rows in another language (a source
 * segment beside takes) are not examples for each other.
 */
export function pickCleanupPairs(
  rows: readonly TranscriptRow[],
  target: TranscriptRow,
  heard: string,
  learned: readonly CorrectionRule[],
): CleanupPair[] {
  const words = wordSet(heard)
  const seen = new Set<string>()
  return rows
    .filter((r) => r !== target && r.isSourceSegment === target.isSourceSegment && r.cell.id !== target.cell.id)
    .filter((r) => isHumanCorrected(r, learned) || (r.validated && !!r.heard && loose(r.heard) !== loose(r.transcript)))
    .map((r) => {
      let overlap = 0
      for (const w of wordSet(r.heard!)) if (words.has(w)) overlap++
      return { r, overlap }
    })
    .sort((a, b) => b.overlap - a.overlap)
    .filter(({ r }) => {
      const key = `${loose(r.heard!)}\u0000${loose(r.transcript)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, CLEANUP_MAX_PAIRS)
    .map(({ r }) => ({ heard: r.heard!, corrected: r.transcript }))
}

/** Transcripts a person validated that have no saved ASR text: spelling
 *  examples when the lane has few pairs. */
export function pickCorrectedOnly(rows: readonly TranscriptRow[], target: TranscriptRow): string[] {
  return rows
    .filter((r) => r !== target && r.isSourceSegment === target.isSourceSegment && !r.heard && r.validated && r.transcript)
    .slice(0, CLEANUP_MAX_PAIRS)
    .map((r) => r.transcript)
}

/**
 * Key terms in the language of the speech. Source speech uses the concepts'
 * headwords; a take uses the lane's approved renderings (the concepts arrive
 * already filtered to the active lane).
 */
export function cleanupTerms(concepts: readonly Concept[], isSourceSegment: boolean): { term: string }[] {
  const out = new Set<string>()
  for (const c of concepts) {
    if (c.status === "deprecated") continue
    if (isSourceSegment) {
      if (c.sourceTerm.trim()) out.add(c.sourceTerm.trim())
    } else {
      for (const r of c.renderings) if (r.status !== "forbidden" && r.rendering.trim()) out.add(r.rendering.trim())
    }
    if (out.size >= CLEANUP_MAX_TERMS) break
  }
  return [...out].slice(0, CLEANUP_MAX_TERMS).map((term) => ({ term }))
}

/** Source segments only: the transcripts around this one, in order. */
export function neighbourTranscripts(rows: readonly TranscriptRow[], target: TranscriptRow, radius = 2): string[] {
  if (!target.isSourceSegment) return []
  const i = rows.indexOf(target)
  if (i < 0) return []
  return rows
    .slice(Math.max(0, i - radius), i + radius + 1)
    .filter((r) => r !== target && r.isSourceSegment && r.transcript)
    .map((r) => r.transcript)
}
