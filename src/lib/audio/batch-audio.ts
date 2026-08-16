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
 * Free timing cannot lay them out).
 *
 * The hard part is NOT-measuring the SHARED clips, whose per-cell length comes
 * from each cell's trim window rather than from the object — writing the whole
 * object's length onto them would stretch every participating chip across the
 * entire clip, and the fill-only projection makes that permanent. There are
 * two such objects and they hide in different ways:
 *
 *   - the imported source clip, seeded with the FILE id and attached to every
 *     media section;
 *   - the combined "voice together" generation, seeded with the FIRST chosen
 *     cell's id (combined-voice.ts) and attached untrimmed to all of them —
 *     so on cells 2..N it looks like an ordinary foreign-seeded take, and on
 *     cell 1 it looks like that cell's own take.
 *
 * So a take qualifies only when it is seeded with its OWN cell's id AND no
 * other cell in the file carries the same object. Legacy ids that predate the
 * seeding convention fail the first test and are simply left alone: a chip
 * that keeps its guessed width is a far better outcome than one measured
 * wrong and unfixable.
 */
export function attachmentNeedsMeasure(
  fileId: string,
  cellId: string,
  att: AudioAttachmentOut,
  isSharedAcrossCells: (audioId: string) => boolean,
): boolean {
  if (att.durationMs != null) return false
  if (att.pendingSync) return false
  if (audioIdSeededWith(att.audioId, fileId)) return false
  if (!audioIdSeededWith(att.audioId, cellId)) return false
  return !isSharedAcrossCells(att.audioId)
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
  // How many cells carry each object: >1 means a shared clip (see above).
  const cellsPerAudioId = new Map<string, number>()
  for (const entry of byCellId.values()) {
    for (const audioId of Object.keys(entry.attachments)) {
      cellsPerAudioId.set(audioId, (cellsPerAudioId.get(audioId) ?? 0) + 1)
    }
  }
  const isShared = (audioId: string) => (cellsPerAudioId.get(audioId) ?? 0) > 1

  const out: MeasureTarget[] = []
  for (const [cellId, entry] of byCellId) {
    for (const att of Object.values(entry.attachments)) {
      if (attachmentNeedsMeasure(fileId, cellId, att, isShared)) out.push({ cellId, att })
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
  // One progress slot, three batch kinds: starting on top of a running batch
  // would make both write and clear it (and the banner's Cancel would target
  // whichever happened to be displayed). The button is disabled while one
  // runs; this closes the gap between that render and the click.
  if (getBatchProgress() != null) return result

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
        // AWAIT the emit: it rejects when the account is below the event's
        // role floor (and on an IDB write failure), and an unawaited promise
        // would let every such take count as measured — a run that saved
        // nothing would report full success.
        const eventId = await emitCellAudioMeasure({
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
