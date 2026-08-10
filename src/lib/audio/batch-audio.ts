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

export type BatchKind = "transcribe" | "synth" | "measure"

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
import { audioIdSeededWith } from "./upload"
import { getTranscribeStatus } from "./transcribe-status"
import { generateCellVoice } from "./voice-generate-helpers"
import { ttsStatusKey, getTtsStatus } from "./tts"
import type { ProjectRecord } from "@/lib/parsers/types"

let _transcribeCancelFlag = false
let _synthCancelFlag = false
let _measureCancelFlag = false

export function cancelBatchTranscribe() {
  _transcribeCancelFlag = true
}

export function cancelBatchSynth() {
  _synthCancelFlag = true
}

export function cancelBatchMeasure() {
  _measureCancelFlag = true
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
  // SUB-29: the source-vs-take split is attachment PROVENANCE, not cell
  // medium — a dub take recorded onto a media section follows the take rule.
  if (isSourceSegmentSelected(c)) return !c.transcription?.trim()
  const existingTimings = c.audioTimings?.[c.selectedAudioId]
  return !existingTimings || existingTimings.length === 0
}

/** SUB-29: true when a media cell's selected recording is the IMPORTED SOURCE
 *  CLIP (audioId seeded with the fileId) rather than a user take (seeded with
 *  the cellId). Ambiguous/legacy ids on media cells default to source — the
 *  safe side for transcription. Shared by the batch predicates + language
 *  routing here and in the workspace call sites. */
export function isSourceSegmentSelected(c: CellData): boolean {
  if (c.medium !== "media" || !c.selectedAudioId) return false
  return !audioIdSeededWith(c.selectedAudioId, c.id)
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
        // AQU-646/SUB-29: language follows the audio by PROVENANCE — source
        // segments are source speech; every take (incl. dub takes on media
        // cells) voices the target text.
        language: isSourceSegmentSelected(cell) ? (args.sourceLanguage ?? targetLang) : targetLang,
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

// ---------------------------------------------------------------------------
// Measure-all (duration backfill for takes that predate duration capture)
// ---------------------------------------------------------------------------

import type { AudioAttachmentOut, CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { parseFrontierAudioUrl, fetchCellAudio } from "./upload"
import { audioCacheGet, audioCachePut } from "./bytes-cache"
import { makeAudioSyncTokenFetcher } from "./sync-token-fetcher"
import { probeDurationMsSafe } from "@/lib/import"
import { emitCellAudioMeasure } from "@/lib/sync/events-emit"
import {
  injectOptimisticAudioAttachment,
  notifyAudioAttachmentsChanged,
} from "./audio-attachments-bus"

/**
 * A take needs its length measured when nothing recorded one at attach time
 * (pre-duration-capture recordings; their chips draw at fallback width and
 * Free timing cannot lay them out). The imported SOURCE clip legitimately has
 * no duration of its own — its length is the section span — so fileId-seeded
 * ids never count. Shared by the timeline notice's count and the batch.
 */
export function attachmentNeedsMeasure(fileId: string, att: AudioAttachmentOut): boolean {
  if (att.durationMs != null) return false
  if (att.pendingSync) return false
  return !audioIdSeededWith(att.audioId, fileId)
}

export interface MeasureTarget {
  cellId: string
  att: AudioAttachmentOut
}

/** Every take in the file that `attachmentNeedsMeasure` — the banner's count
 *  and the batch's work-list come from the same enumeration. */
export function takesNeedingMeasure(
  fileId: string,
  byCellId: ReadonlyMap<string, CellAudioEntry>,
): MeasureTarget[] {
  const out: MeasureTarget[] = []
  for (const [cellId, entry] of byCellId) {
    for (const att of Object.values(entry.attachments)) {
      if (attachmentNeedsMeasure(fileId, att)) out.push({ cellId, att })
    }
  }
  return out
}

export interface MeasureAllArgs {
  projectId: string
  fileId: string
  byCellId: ReadonlyMap<string, CellAudioEntry>
  session: FrontierSession | null
  username: string
}

export interface MeasureAllResult {
  measured: number
  /** Bytes missing (404) or undecodable — these can only be re-recorded. */
  failed: number
}

/**
 * Download, decode, and record the real length of every legacy take in the
 * file. Deliberately user-initiated (the timeline notice's button) — never
 * silent. Each measurement is a narrow `cell.audio.measure` event: fill-only
 * on the server, so it can never overwrite fresher data, and it never touches
 * selection — measuring a non-selected take must not promote it.
 */
export async function runMeasureAll(args: MeasureAllArgs): Promise<MeasureAllResult> {
  const { projectId, fileId, byCellId, session, username } = args
  const targets = takesNeedingMeasure(fileId, byCellId)
  const result: MeasureAllResult = { measured: 0, failed: 0 }
  if (targets.length === 0) return result

  _measureCancelFlag = false

  await runBatch(
    targets,
    async ({ cellId, att }) => {
      try {
        const frontier = parseFrontierAudioUrl(att.url)
        if (!frontier) {
          result.failed++
          return
        }
        // Local-first, like transcribe: a take's bytes may live in the OPFS
        // cache; only the network fallback needs a session.
        let bytes = await audioCacheGet(frontier.audioId, frontier.ext)
        if (!bytes) {
          bytes = await fetchCellAudio({
            projectId,
            fileId,
            audioId: frontier.audioId,
            ext: frontier.ext,
            getSyncToken: makeAudioSyncTokenFetcher(() => session),
          })
          void audioCachePut(frontier.audioId, frontier.ext, bytes)
        }
        const durationMs = await probeDurationMsSafe(
          new Blob([bytes as BlobPart], { type: att.mimeType ?? "audio/webm" }),
        )
        if (durationMs == null || !(durationMs > 0)) {
          result.failed++
          return
        }
        const rounded = Math.round(durationMs)
        const eventId = emitCellAudioMeasure({
          projectId,
          fileId,
          cellId,
          audioId: att.audioId,
          durationMs: rounded,
          author: username,
        })
        // Paint immediately, WITHOUT claiming selection — the whole point of
        // the measure event is that fixing an arbitrary take never changes
        // which take is active.
        injectOptimisticAudioAttachment(
          fileId,
          cellId,
          { ...att, durationMs: rounded },
          eventId,
          { claimSelection: false },
        )
        notifyAudioAttachmentsChanged(fileId)
        result.measured++
      } catch {
        // 404 / network / decode failure: the take keeps its fallback-width
        // chip; the caller reports the count.
        result.failed++
      }
    },
    {
      kind: "measure",
      isCancelled: () => _measureCancelFlag,
      onItemDone: () => { /* the notice's count shrinks via the bus */ },
    },
  )

  return result
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
