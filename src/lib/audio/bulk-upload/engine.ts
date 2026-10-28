// AQU-981: the bulk upload engine — every matched recording to R2 and onto its
// line, a few at a time, with retries, an honest offline pause, Cancel, and a
// list of what failed and why.
//
// Each take is stored EXACTLY as the one-file upload stores it (same R2 object
// layout, same cell.audio.attach, same cell-seeded id, no label) — it goes
// through `attachUploadedTake`, the attach half the picker uses — so a future
// project-wide Library lists bulk uploads with nothing to migrate. Two shapes
// are new, and both are made of events that already exist:
//
//   - A RANGE ("Genesis 1:1-3") is one object, attached to every line it
//     covers. Each line's take has its own cell-seeded id over the shared url
//     — the way a cut take's pieces share one recording — so every line counts
//     as recorded and reads as its own take, where one id on every line (Voice
//     together's way) reads as a take borrowed from the first line.
//   - PIECES (a verse in parts) are decoded, joined into one WAV in order and
//     uploaded once, then cut at the joins with `cell.audio.cut`: pieces of one
//     take, which is the only shape the app can play in order today.
//
// Runs outside React, in module scope, so it carries on when the dialog that
// started it closes. The banner (RecordingsUploadBanner) watches the store.

import { useSyncExternalStore } from "react"
import type { FrontierSession } from "@/lib/frontier/types"
import { buildAudioId, uploadCellAudio, MAX_AUDIO_OBJECT_BYTES, type AudioUploadResult } from "@/lib/audio/upload"
import { attachUploadedTake, extFromFile } from "@/lib/audio/attach-file"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { markProjectHasAudioDataSoon } from "@/lib/audio/project-audio-state"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { newPieceAudioId, CUT_MIN_PIECE_MS } from "@/lib/audio/cut-take"
import { emitCellAudioCut } from "@/lib/sync/events-emit"
import { RECORDING_SLOT } from "@/lib/timeline/track-slots"
import { probeDurationMsSafe } from "@/lib/import"
import type { UploadJob } from "./match"

/** The largest file bulk upload accepts: R2's multipart cap (AQU-1853). */
export const BULK_MAX_FILE_BYTES = MAX_AUDIO_OBJECT_BYTES

/** Uploads in flight at once. The browser allows six connections to the sync
 *  worker; the outbox flush and the editor's reads need the others. */
export const BULK_CONCURRENCY = 4

/** Waits before each retry of a transient failure, on top of the upload's own
 *  quick retries (upload.ts): a dropped connection gets about half a minute. */
const RETRY_DELAYS_MS = [2_000, 6_000, 15_000] as const

/** The attachments read is poked at most this often per file while it runs. */
const NOTIFY_EVERY_MS = 1_500

export type BulkFailureCode = "offline" | "network" | "server" | "tooShort" | "decode" | "other"

export interface BulkFailure {
  /** Input index of the file (the first file of a job of pieces). */
  index: number
  name: string
  /** Where it was going, as the preview showed it ("Genesis 1:3"). */
  target: string
  code: BulkFailureCode
  /** The underlying message, for the details line. */
  message: string
}

export interface BulkUploadState {
  /** Recordings (files) in the run. */
  total: number
  /** Files uploaded and on their line. */
  done: number
  failed: BulkFailure[]
  /** Files never started because the run was cancelled. */
  notStarted: number
  cancelled: boolean
  /** Paused until the browser is back online. */
  waitingForConnection: boolean
  finished: boolean
  startedAt: number
  finishedAt: number | null
}

export interface BulkUploadRequest {
  projectId: string
  session: FrontierSession
  username: string
  /** The lane the person is on; omitted for the default lane. */
  targetLang?: string
  jobs: readonly UploadJob[]
  /** The picked files, by input index. */
  files: readonly File[]
  /** "Genesis 1:3" for a job, as the preview named it. */
  targetLabel: (job: UploadJob) => string
}

// ── Store ────────────────────────────────────────────────────────────────────

let state: BulkUploadState | null = null
const listeners = new Set<() => void>()
let cancelFlag = false
let abort: AbortController | null = null
/** What the last run was asked to do, so "Try again" can redo its failures. */
let lastRequest: BulkUploadRequest | null = null
let failedJobs: UploadJob[] = []

function emit() {
  for (const l of listeners) l()
}

function setState(next: BulkUploadState | null) {
  state = next
  emit()
}

function patch(p: Partial<BulkUploadState>) {
  if (!state) return
  setState({ ...state, ...p })
}

export function getBulkUploadState(): BulkUploadState | null {
  return state
}

export function useBulkUploadState(): BulkUploadState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    getBulkUploadState,
    () => null,
  )
}

export function isBulkUploadRunning(): boolean {
  return state != null && !state.finished
}

/** Stop starting new files; the ones in flight are aborted. */
export function cancelBulkUpload(): void {
  if (!state || state.finished) return
  cancelFlag = true
  abort?.abort()
  patch({ cancelled: true })
  wakeOnline()
}

/** Clear a finished run's summary. */
export function dismissBulkUpload(): void {
  if (state && !state.finished) return
  setState(null)
  lastRequest = null
  failedJobs = []
}

/** Run the last run's failed files again. */
export function retryFailedBulkUploads(): Promise<void> {
  if (!lastRequest || failedJobs.length === 0 || isBulkUploadRunning()) return Promise.resolve()
  return startBulkUpload({ ...lastRequest, jobs: failedJobs })
}

// ── Connection ───────────────────────────────────────────────────────────────

let onlineWaiters: Array<() => void> = []

function wakeOnline() {
  const waiters = onlineWaiters
  onlineWaiters = []
  for (const w of waiters) w()
}

if (typeof window !== "undefined") window.addEventListener("online", wakeOnline)

/** Resolve once the browser says it is online (or the run is cancelled). */
async function waitForConnection(): Promise<void> {
  while (!cancelFlag && typeof navigator !== "undefined" && !navigator.onLine) {
    patch({ waitingForConnection: true })
    await new Promise<void>((resolve) => {
      onlineWaiters.push(resolve)
      // Some browsers never fire "online" after a sleep; look again anyway.
      setTimeout(resolve, 5_000)
    })
  }
  if (state?.waitingForConnection) patch({ waitingForConnection: false })
}

// ── Failure classes ──────────────────────────────────────────────────────────

class JobError extends Error {
  readonly code: BulkFailureCode
  constructor(code: BulkFailureCode, message: string) {
    super(message)
    this.code = code
  }
}

function classify(err: unknown): JobError {
  if (err instanceof JobError) return err
  const message = err instanceof Error ? err.message : String(err)
  if (typeof navigator !== "undefined" && !navigator.onLine) return new JobError("offline", message)
  // fetch's own wordings for a dropped connection (Chrome, Safari, Firefox) —
  // anchored, because "audio upload failed (403)" contains "load failed".
  if (err instanceof TypeError || /^(failed to fetch|load failed)$|networkerror/i.test(message)) return new JobError("network", message)
  if (/\((5\d\d|429|408)\)/.test(message)) return new JobError("server", message)
  return new JobError("other", message)
}

function isTransient(err: JobError): boolean {
  return err.code === "offline" || err.code === "network" || err.code === "server"
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ── One job ──────────────────────────────────────────────────────────────────

interface RunContext {
  req: BulkUploadRequest
  getSyncToken: ReturnType<typeof audioSyncTokenFetcherForSession>
  signal: AbortSignal
  touched: Set<string>
  notifyTimers: Map<string, ReturnType<typeof setTimeout>>
}

function scheduleNotify(ctx: RunContext, fileId: string) {
  ctx.touched.add(fileId)
  if (ctx.notifyTimers.has(fileId)) return
  ctx.notifyTimers.set(fileId, setTimeout(() => {
    ctx.notifyTimers.delete(fileId)
    notifyAudioAttachmentsChanged(fileId)
  }, NOTIFY_EVERY_MS))
}

/** The R2 PUT, retried through a dropped connection. */
async function uploadWithRetry(ctx: RunContext, args: { fileId: string; audioId: string; ext: string; blob: Blob }): Promise<AudioUploadResult> {
  for (let attempt = 0; ; attempt++) {
    await waitForConnection()
    if (cancelFlag) throw new JobError("other", "cancelled")
    try {
      return await uploadCellAudio({
        projectId: ctx.req.projectId,
        fileId: args.fileId,
        audioId: args.audioId,
        ext: args.ext,
        blob: args.blob,
        getSyncToken: ctx.getSyncToken,
        signal: ctx.signal,
      })
    } catch (e) {
      if (cancelFlag) throw new JobError("other", "cancelled")
      const err = classify(e)
      if (!isTransient(err) || attempt >= RETRY_DELAYS_MS.length) throw err
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
}

function attachFields(ctx: RunContext) {
  return {
    projectId: ctx.req.projectId,
    slot: RECORDING_SLOT,
    username: ctx.req.username,
    // Bulk upload is a batch surface; the take itself is an ordinary attach.
    surface: "batch" as const,
    ...(ctx.req.targetLang ? { targetLang: ctx.req.targetLang } : {}),
  }
}

/** One file onto one line: exactly the one-file upload's take. */
async function uploadOne(ctx: RunContext, fileId: string, cellId: string, file: File): Promise<void> {
  const ext = extFromFile(file)
  const result = await uploadWithRetry(ctx, { fileId, audioId: buildAudioId(cellId), ext, blob: file })
  markProjectHasAudioDataSoon(ctx.req.projectId)
  const durationMs = await probeDurationMsSafe(file)
  await attachUploadedTake({
    ...attachFields(ctx),
    fileId,
    cellId,
    audioId: `${result.audioId}.${result.ext}`,
    url: result.url,
    mimeType: file.type || undefined,
    durationMs,
  })
  scheduleNotify(ctx, fileId)
}

/** One file over several lines: one object, a take of it on every line. */
async function uploadRange(ctx: RunContext, fileId: string, cellIds: readonly string[], file: File): Promise<void> {
  const ext = extFromFile(file)
  const result = await uploadWithRetry(ctx, { fileId, audioId: buildAudioId(cellIds[0]), ext, blob: file })
  markProjectHasAudioDataSoon(ctx.req.projectId)
  const durationMs = await probeDurationMsSafe(file)
  for (const [i, cellId] of cellIds.entries()) {
    await attachUploadedTake({
      ...attachFields(ctx),
      fileId,
      cellId,
      // The first line's take IS the object; every other line's take is its
      // own cell-seeded id over the same url.
      audioId: i === 0 ? `${result.audioId}.${result.ext}` : `${buildAudioId(cellId)}.${result.ext}`,
      url: result.url,
      mimeType: file.type || undefined,
      durationMs,
    })
  }
  scheduleNotify(ctx, fileId)
}

/** The parts of one verse: joined in order, uploaded once, cut at the joins. */
async function uploadPieces(ctx: RunContext, fileId: string, cellId: string, files: readonly File[]): Promise<void> {
  const { decodeToMono48k, concatPcm, TARGET_RATE } = await import("@/lib/audio/decode-mono")
  const { encodeWavPcm16 } = await import("@/lib/audio/wav-encode")
  const pcm: Float32Array[] = []
  for (const f of files) {
    try {
      pcm.push(await decodeToMono48k(new Uint8Array(await f.arrayBuffer())))
    } catch (e) {
      throw new JobError("decode", `${f.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const lengthsMs = pcm.map((p) => (p.length / TARGET_RATE) * 1000)
  if (lengthsMs.some((ms) => ms < CUT_MIN_PIECE_MS + 20)) {
    throw new JobError("tooShort", "a part is shorter than a piece may be")
  }
  const joined = encodeWavPcm16(concatPcm(pcm), TARGET_RATE)
  const result = await uploadWithRetry(ctx, { fileId, audioId: buildAudioId(cellId), ext: "wav", blob: joined })
  markProjectHasAudioDataSoon(ctx.req.projectId)
  const rootId = `${result.audioId}.${result.ext}`
  const totalMs = Math.round(lengthsMs.reduce((a, b) => a + b, 0))
  await attachUploadedTake({
    ...attachFields(ctx),
    fileId,
    cellId,
    audioId: rootId,
    url: result.url,
    mimeType: "audio/wav",
    durationMs: totalMs,
  })
  // Cut the last piece at each join in turn: the root keeps the first part,
  // and each cut's new piece is the rest, cut again at the next join.
  let lastPiece = rootId
  let at = 0
  for (const ms of lengthsMs.slice(0, -1)) {
    at += ms
    const newAudioId = newPieceAudioId(cellId, rootId)
    await emitCellAudioCut({
      projectId: ctx.req.projectId,
      fileId,
      cellId,
      audioId: lastPiece,
      atMs: Math.round(at),
      newAudioId,
      ...(ctx.req.targetLang ? { targetLang: ctx.req.targetLang } : {}),
      author: ctx.req.username,
    })
    lastPiece = newAudioId
  }
  scheduleNotify(ctx, fileId)
}

/** Files in a job — what the counts are made of. */
function filesIn(job: UploadJob): number {
  return job.files.length
}

async function runJob(ctx: RunContext, job: UploadJob): Promise<void> {
  const files = job.files.map((i) => ctx.req.files[i])
  switch (job.kind) {
    case "single":
      // Numbered takes of one line, one after another, so the last plays.
      for (const f of files) await uploadOne(ctx, job.fileId, job.cellId, f)
      return
    case "range":
      return uploadRange(ctx, job.fileId, job.cellIds, files[0])
    case "pieces":
      return uploadPieces(ctx, job.fileId, job.cellId, files)
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!isBulkUploadRunning()) return
  e.preventDefault()
  // Older browsers want a returnValue to show their own prompt.
  e.returnValue = ""
}

/**
 * Upload every job. Resolves when the run is over — finished, cancelled, or
 * with failures listed in the store. Never rejects for one file's failure.
 */
export async function startBulkUpload(req: BulkUploadRequest): Promise<void> {
  if (isBulkUploadRunning()) throw new Error("An upload is already running")
  cancelFlag = false
  abort = new AbortController()
  lastRequest = req
  failedJobs = []
  const total = req.jobs.reduce((n, job) => n + filesIn(job), 0)
  setState({
    total,
    done: 0,
    failed: [],
    notStarted: 0,
    cancelled: false,
    waitingForConnection: false,
    finished: false,
    startedAt: Date.now(),
    finishedAt: null,
  })
  const ctx: RunContext = {
    req,
    getSyncToken: audioSyncTokenFetcherForSession(req.session),
    signal: abort.signal,
    touched: new Set(),
    notifyTimers: new Map(),
  }
  if (typeof window !== "undefined") window.addEventListener("beforeunload", onBeforeUnload)

  let next = 0
  const queue = [...req.jobs]
  const worker = async () => {
    while (next < queue.length) {
      if (cancelFlag) return
      const job = queue[next++]
      try {
        await runJob(ctx, job)
        patch({ done: (state?.done ?? 0) + filesIn(job) })
      } catch (e) {
        if (cancelFlag) {
          patch({ notStarted: (state?.notStarted ?? 0) + filesIn(job) })
          return
        }
        const err = classify(e)
        failedJobs.push(job)
        const first = job.files[0]
        patch({
          failed: [
            ...(state?.failed ?? []),
            { index: first, name: req.files[first]?.name ?? "", target: req.targetLabel(job), code: err.code, message: err.message },
          ],
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, queue.length) }, () => worker()))

  const unstarted = queue.slice(next).reduce((n, job) => n + filesIn(job), 0)
  for (const timer of ctx.notifyTimers.values()) clearTimeout(timer)
  for (const fileId of ctx.touched) notifyAudioAttachmentsChanged(fileId)
  if (typeof window !== "undefined") window.removeEventListener("beforeunload", onBeforeUnload)
  abort = null
  patch({
    notStarted: (state?.notStarted ?? 0) + unstarted,
    finished: true,
    finishedAt: Date.now(),
    waitingForConnection: false,
  })
  // A clean run needs no summary once it is done.
  if (state && state.failed.length === 0 && !state.cancelled) {
    const doneState = state
    setTimeout(() => { if (state === doneState) dismissBulkUpload() }, 6_000)
  }
}

/** Test seam: forget everything between tests. */
export function __resetBulkUploadForTests(): void {
  state = null
  cancelFlag = false
  abort = null
  lastRequest = null
  failedJobs = []
  onlineWaiters = []
  listeners.clear()
}
