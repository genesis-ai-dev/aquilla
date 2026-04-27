// Bulk orchestrators: transcribe every recorded cell in a file, or generate
// AI voice for every text-only cell. Both surface progress through the
// existing per-cell status registries so the inline badges, transcript
// previews and floating chips all light up automatically as work proceeds.

import * as Y from "yjs"
import { useSyncExternalStore } from "react"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { transcribeAndStoreTimings } from "./transcribe"
import { whisperLanguageFromTag } from "./language"
import { setTranscribeStatus } from "./transcribe-status"
import { synthAndAttachAudio } from "./synth-and-attach"
import { setTtsStatus } from "./tts"
import { fetchCellAudio, parseFrontierAudioUrl } from "./upload"

// ── Shared progress store ───────────────────────────────────────────────────
//
// Bulk runs publish to a single page-local store so the workspace can render
// one persistent progress banner (regardless of which feature is running).

export type BulkKind = "transcribe-all" | "synth-all"

export interface BulkProgress {
  kind: BulkKind
  total: number
  completed: number
  failed: number
  currentCellLabel?: string
  startedAt: number
}

export type BulkState =
  | { kind: "idle" }
  | { kind: "running"; progress: BulkProgress }
  | { kind: "done"; progress: BulkProgress; finishedAt: number }

const IDLE: BulkState = { kind: "idle" }
let state: BulkState = IDLE
let cancelRequested = false
const listeners = new Set<() => void>()

function notify() { for (const l of listeners) l() }
function setState(next: BulkState): void { state = next; notify() }

export function getBulkState(): BulkState { return state }

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useBulkState(): BulkState {
  return useSyncExternalStore(subscribe, () => state, () => IDLE)
}

export function cancelBulkOperation(): void {
  cancelRequested = true
}

// ── Transcribe-all ──────────────────────────────────────────────────────────

export interface TranscribeAllArgs {
  doc: Y.Doc
  cells: CellData[]
  project: ProjectRecord
  session: FrontierSession
}

export function countTranscribeTargets(cells: CellData[]): number {
  return cells.filter((c) => {
    const audioId = c.selectedAudioId
    if (!audioId) return false
    const att = c.attachments?.[audioId]
    if (!att || att.isDeleted) return false
    const existing = c.audioTimings?.[audioId]
    return !existing || existing.length === 0
  }).length
}

/** Run Whisper on every cell that has audio but no timings yet. */
export async function transcribeAllInFile(args: TranscribeAllArgs): Promise<void> {
  const targets = args.cells.filter((c) => {
    const audioId = c.selectedAudioId
    if (!audioId) return false
    const att = c.attachments?.[audioId]
    if (!att || att.isDeleted) return false
    const existing = c.audioTimings?.[audioId]
    return !existing || existing.length === 0
  })
  await runBulk(args.doc, targets, "transcribe-all", async (doc, cell) => {
    const audioId = cell.selectedAudioId!
    const att = cell.attachments![audioId]
    setTranscribeStatus(audioId, { kind: "loading", loaded: 0, total: 0, file: "" })
    const startedAt = Date.now()
    try {
      const bytes = await fetchAudioBytesForCell(att.url, args.project, args.session)
      const out = await transcribeAndStoreTimings(doc, cell.id, audioId, bytes, {
        cellText: cell.translated,
        language: whisperLanguageFromTag(args.project.targetLanguage),
        onProgress: (p) => {
          setTranscribeStatus(audioId, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
          if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
            setTranscribeStatus(audioId, { kind: "transcribing" })
          }
        },
      })
      setTranscribeStatus(audioId, { kind: "done", wordCount: out.timings.length, durationMs: Date.now() - startedAt })
    } catch (e) {
      setTranscribeStatus(audioId, { kind: "error", message: e instanceof Error ? e.message : String(e) })
      throw e
    }
  })
}

// ── Synth-all ───────────────────────────────────────────────────────────────

export interface SynthAllArgs {
  doc: Y.Doc
  cells: CellData[]
  project: ProjectRecord
  session: FrontierSession
  username: string
  /** When false, cells that already have an audio attachment are skipped.
   *  When true, the existing recording is replaced. Default false. */
  replaceExisting?: boolean
}

export function countSynthTargets(cells: CellData[], replaceExisting: boolean): number {
  return cells.filter((c) => {
    if (!c.translated.trim()) return false
    if (replaceExisting) return true
    const audioId = c.selectedAudioId
    const att = audioId ? c.attachments?.[audioId] : undefined
    return !att || att.isDeleted === true
  }).length
}

/** Run Kokoro + Whisper on every cell with text but no recording. */
export async function synthAllInFile(args: SynthAllArgs): Promise<void> {
  const targets = args.cells.filter((c) => {
    if (!c.translated.trim()) return false
    if (args.replaceExisting) return true
    const audioId = c.selectedAudioId
    const att = audioId ? c.attachments?.[audioId] : undefined
    return !att || att.isDeleted === true
  })
  await runBulk(args.doc, targets, "synth-all", async (doc, cell) => {
    const key = `synth:${cell.id}`
    setTtsStatus(key, { kind: "loading", loaded: 0, total: 0, file: "" })
    try {
      await synthAndAttachAudio({
        doc, cellId: cell.id, cellText: cell.translated,
        projectId: args.project.id,
        languageTag: args.project.targetLanguage,
        session: args.session, username: args.username,
        onTtsProgress: (p) => {
          setTtsStatus(key, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
          if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
            setTtsStatus(key, { kind: "synthesizing" })
          }
        },
      })
      setTtsStatus(key, { kind: "idle" })
    } catch (e) {
      setTtsStatus(key, { kind: "error", message: e instanceof Error ? e.message : String(e) })
      throw e
    }
  })
}

// ── Internals ───────────────────────────────────────────────────────────────

async function fetchAudioBytesForCell(
  attachmentUrl: string,
  project: ProjectRecord,
  session: FrontierSession,
): Promise<Uint8Array> {
  const frontier = parseFrontierAudioUrl(attachmentUrl)
  if (!frontier) {
    throw new Error("bulk transcribe currently supports only frontier-audio:// attachments")
  }
  return fetchCellAudio({
    session,
    projectId: project.id,
    audioId: frontier.audioId,
    ext: frontier.ext,
  })
}

async function runBulk(
  doc: Y.Doc,
  cells: CellData[],
  kind: BulkKind,
  perCell: (doc: Y.Doc, cell: CellData) => Promise<void>,
): Promise<void> {
  cancelRequested = false
  const startedAt = Date.now()
  const progress: BulkProgress = {
    kind, total: cells.length, completed: 0, failed: 0, startedAt,
  }
  setState({ kind: "running", progress })

  for (const cell of cells) {
    if (cancelRequested) break
    progress.currentCellLabel = cell.cellLabel || cell.id.slice(0, 12)
    setState({ kind: "running", progress: { ...progress } })
    try {
      await perCell(doc, cell)
      progress.completed += 1
    } catch (e) {
      console.warn("[bulk-audio] cell failed:", cell.id, e)
      progress.failed += 1
    }
    setState({ kind: "running", progress: { ...progress } })
  }

  const finishedAt = Date.now()
  setState({ kind: "done", progress, finishedAt })
  // Auto-clear after a short delay so the banner doesn't linger forever.
  setTimeout(() => {
    const cur = getBulkState()
    if (cur.kind === "done" && cur.finishedAt === finishedAt) setState(IDLE)
  }, 8000)
}
