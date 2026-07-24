// Batch transcribe-all and synth-all drivers.
//
// Both follow the same pattern:
//   1. Filter cells to those with work to do.
//   2. Run them sequentially with a small concurrency window (default: 2).
//   3. Maintain a cancellation flag so the AudioBulkProgressBanner can stop it.
//   4. Expose progress via a lightweight pub-sub store so the banner re-renders.
//
// Progress is intentionally separate from the per-cell transcribe-status /
// tts-status stores — the banner shows aggregate throughput, per-cell badges
// show per-cell state.

import { useSyncExternalStore } from "react"

// ---------------------------------------------------------------------------
// Progress store
// ---------------------------------------------------------------------------

export type BatchKind = "transcribe" | "synth"

export interface BatchProgress {
  kind: BatchKind
  total: number
  done: number
  /** Signals were cancelled; in-flight cells may still complete. */
  cancelled: boolean
}

let _progress: BatchProgress | null = null
const _listeners = new Set<() => void>()

function notify() {
  for (const l of _listeners) l()
}

export function getBatchProgress(): BatchProgress | null {
  return _progress
}

function setBatchProgress(p: BatchProgress | null) {
  _progress = p
  notify()
}

function subscribe(listener: () => void): () => void {
  _listeners.add(listener)
  return () => { _listeners.delete(listener) }
}

export function useBatchProgress(): BatchProgress | null {
  return useSyncExternalStore(subscribe, getBatchProgress, () => null)
}

// ---------------------------------------------------------------------------
// Generic batch runner
// ---------------------------------------------------------------------------

const CONCURRENCY = 2

/**
 * Run `fn` over `items` with a sliding concurrency window.
 * Stops accepting new work when `isCancelled()` returns true (in-flight jobs
 * complete naturally).
 */
async function runBatch<T>(
  items: T[],
  fn: (item: T) => Promise<unknown>,
  opts: {
    kind: BatchKind
    isCancelled: () => boolean
    onItemDone: () => void
  },
): Promise<void> {
  const { kind, isCancelled, onItemDone } = opts
  const total = items.length
  let done = 0
  let idx = 0

  setBatchProgress({ kind, total, done, cancelled: false })

  async function runNext(): Promise<void> {
    while (idx < total) {
      if (isCancelled()) break
      const item = items[idx++]
      await fn(item)
      done++
      onItemDone()
      setBatchProgress({
        kind,
        total,
        done,
        cancelled: isCancelled(),
      })
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => runNext())
  await Promise.all(workers)

  setBatchProgress(null)
}

// ---------------------------------------------------------------------------
// Transcribe-all
// ---------------------------------------------------------------------------

import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import { transcribeCell } from "./transcribe"
import { getTranscribeStatus } from "./transcribe-status"
import { generateCellVoice } from "./voice-generate-helpers"
import { ttsStatusKey, getTtsStatus } from "./tts"
import type { ProjectRecord } from "@/lib/parsers/types"

let _transcribeCancelFlag = false
let _synthCancelFlag = false

export function cancelBatchTranscribe() {
  _transcribeCancelFlag = true
}

export function cancelBatchSynth() {
  _synthCancelFlag = true
}

export interface TranscribeAllArgs {
  cells: CellData[]
  projectId: string
  session: FrontierSession | null
  /** AQU-646: language of SOURCE speech (imported media segments). */
  sourceLanguage?: string
  /** Language of TARGET speech (recorded takes). Falls back to `language`. */
  targetLanguage?: string
  /** @deprecated single-language callers; used as targetLanguage fallback. */
  language?: string
}

/**
 * AQU-646: a cell needs transcription when it has a recording and either
 * (media segment) no transcript text yet, or (recorded take) no word timings
 * for that recording. Shared by runTranscribeAll and the workspace menu count.
 */
export function needsTranscription(c: CellData): boolean {
  if (!c.selectedAudioId) return false
  if (c.medium === "media") return !c.transcription?.trim()
  const existingTimings = c.audioTimings?.[c.selectedAudioId]
  return !existingTimings || existingTimings.length === 0
}

/**
 * Run ASR on every cell that needs it (see `needsTranscription`).
 * Uses the same per-cell `transcribeCell` path the per-cell badge uses.
 */
export async function runTranscribeAll(args: TranscribeAllArgs): Promise<void> {
  const { cells, projectId, session } = args
  const targetLang = args.targetLanguage ?? args.language

  const targets = cells.filter((c) => {
    if (!needsTranscription(c)) return false
    // Skip cells already being transcribed.
    const st = getTranscribeStatus(c.selectedAudioId!)
    if (st.kind === "loading" || st.kind === "transcribing") return false
    return true
  })

  if (targets.length === 0) return

  _transcribeCancelFlag = false

  await runBatch(
    targets,
    (cell) =>
      transcribeCell({
        cell,
        session,
        projectId,
        // AQU-646: language follows the audio — media segments are source
        // speech, recorded takes voice the target text.
        language: cell.medium === "media" ? (args.sourceLanguage ?? targetLang) : targetLang,
      }),
    {
      kind: "transcribe",
      isCancelled: () => _transcribeCancelFlag,
      onItemDone: () => { /* per-cell badge handles its own state */ },
    },
  )
}

// ---------------------------------------------------------------------------
// Synth-all
// ---------------------------------------------------------------------------

export interface SynthAllArgs {
  cells: CellData[]
  project: ProjectRecord
  session: FrontierSession | null
  username: string
}

/** AQU-646: a cell needs synthesis when it has translated text but no
 *  generated voice yet. Shared by runSynthAll and the workspace menu count. */
export function needsSynthesis(c: CellData): boolean {
  return Boolean(c.translated?.trim()) && !c.selectedGeneratedVoiceAudioId
}

/**
 * Generate TTS voice for every cell that has translated text but no generated
 * voice attachment yet. Uses the same `generateCellVoice` path the per-cell
 * voice panel uses.
 */
export async function runSynthAll(args: SynthAllArgs): Promise<void> {
  const { cells, project, session, username } = args

  // Target: cells with translated text but no generated voice audio.
  const targets = cells.filter((c) => {
    if (!needsSynthesis(c)) return false
    // Skip cells already being synthesized.
    const st = getTtsStatus(ttsStatusKey(c.id))
    if (st.kind === "loading" || st.kind === "synthesizing") return false
    return true
  })

  if (targets.length === 0) return

  _synthCancelFlag = false

  await runBatch(
    targets,
    (cell) => generateCellVoice({ project, cell, session, username }),
    {
      kind: "synth",
      isCancelled: () => _synthCancelFlag,
      onItemDone: () => { /* per-cell badge handles its own state */ },
    },
  )
}
