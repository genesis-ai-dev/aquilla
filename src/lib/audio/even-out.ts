// AQU-2664: "Even out" and "Clear" — the actions the UI calls over a set of
// takes (a file, a track, several tracks, a selection).
//
// EVEN OUT sets each take's evened-out target (`cell.audio.even`, its own
// field); take-gain.ts turns target and measured loudness into the correction
// the mixer plays and every export writes. It is its OWN STAGE, before the
// take's own volume and fades (Sam, Nov 19: "I do not want normalization to
// override volume automation"): running, re-running or clearing only ever
// replaces that target — never gain_db, the fades or a track's volume.
// CLEAR sets the target back to null: each take plays at its own volume.
// Each is ONE undo step (a group of `take.even` steps, one per take), whose
// undo leaves alone any take whose target someone changed since.
//
// MEASURING. A take with no loudness reading yet is measured first, once
// (makeTakeMeasurer: fetch, decode, BS.1770 meter, `cell.audio.measure`).
// The meter runs off the page in a Web Worker, with the samples transferred;
// where the worker can't run, on the page in chunks that yield between takes
// and inside long ones (loudness-client.ts), so the editor never freezes.
//
// THE FALLBACK (weak devices, slow networks). Measuring is only ever done
// here, by the action — never by playback or an export, which read the stored
// reading and nothing else. A take that can't be measured (the fetch fails or
// is too slow, the decode fails, the take is too long to decode in this
// device's memory budget, the action is cancelled) is simply SKIPPED: it gets
// no target, plays at its own volume exactly as before, and the result says
// how many were skipped and why. Nothing waits on a measurement but the action.

import { completeStep, recordGroup, type StepInput } from "@/lib/history/history"
import type { TakeEvenData } from "@/lib/history/take-steps"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { CellData } from "@/hooks/useCells"
import { SILENT_LUFS, type LoudnessReading } from "./loudness"
import { loudnessClient } from "./loudness-client"
import { TARGET_RATE } from "./decode-mono"
import { DEFAULT_EVEN_TARGET_LUFS, evenOutCorrection } from "./take-gain"

export interface TakeRef {
  cellId: string
  audioId: string
}

export interface LoudnessFields {
  loudnessLufs: number
  truePeakDb: number
  /** The window of the recording it measured, ms (to null = the end). */
  loudnessFromMs?: number | null
  loudnessToMs?: number | null
}

/** Is this take's reading of another window than its kept part (it was cut
 *  or trimmed since)? It still plays; Even out measures it again. */
export function readingIsStale(att: CodexCellAttachment): boolean {
  if (att.loudnessLufs == null) return false
  return (att.loudnessFromMs ?? 0) !== (att.trimStartMs ?? 0) || (att.loudnessToMs ?? null) !== (att.trimEndMs ?? null)
}

export interface MeasureOptions {
  /** No later take of this run shares the recording: the decode can be
   *  metered in place (no copy) and let go. */
  last?: boolean
}

/** What the actions need from the workspace. */
export interface EvenOutHost {
  /** The take as it reads now (null when gone or deleted). */
  readTake(cellId: string, audioId: string): CodexCellAttachment | null
  /** The workspace's evening-out write (ProjectWorkspace `applyTakeEven`): one
   *  `cell.audio.even` with the target (null clears) and its overlay, queued
   *  in the outbox WITHOUT a flush; the action calls `flush` once after all. */
  applyEven(cellId: string, audioId: string, targetLufs: number | null): Promise<void>
  /** Send the queued writes (one outbox flush for the whole action). */
  flush?(): Promise<void>
  /** May this person even takes out (Contributor, the event's role)? False
   *  refuses the action up front, before anything is downloaded. */
  allowed?: boolean
  /** Measure a take that has no reading (see makeTakeMeasurer); null = couldn't. */
  measure(cellId: string, audioId: string, att: CodexCellAttachment, signal?: AbortSignal, opts?: MeasureOptions): Promise<LoudnessFields | null>
  /** The run is over: let go of what measuring held (the decoded recording,
   *  the recordings that failed this run). */
  release?(): void
  /** Review M2: a FRESH measurer for each run (its own held decode, results
   *  and failures), let go when the run ends. When given, `measure` and
   *  `release` are not used. Two runs never share one: one run's decode,
   *  handed to the worker, would be gone under the other. */
  newMeasurer?(): TakeMeasurer
  /** Review M2: one Even out (or Clear) at a time; a second waits its turn. */
  queue?: EvenOutQueue
  /** The file the takes are in, for the history step ("open … to undo this"). */
  fileId?: string | null
  fileName?: string | null
}

export interface EvenOutOptions {
  /** The loudness to even out to, LUFS. Default −16. */
  targetLufs?: number
  /** Cancels the measuring; takes measured so far are still evened out. */
  signal?: AbortSignal
  /** Measuring progress: takes looked at so far, of how many need measuring. */
  onProgress?: (done: number, total: number) => void
  /** A run over a file or tracks (the window, or the q89 switch): its steps
   *  are ⌘Z's to take back, not the Station's own Undo (board 73C). */
  markAsRun?: boolean
  /** Called at once when another Even out is still running and this one
   *  waits for it (the window says so). */
  onWaiting?: () => void
}

export interface EvenOutResult {
  targetLufs: number
  /** Takes now evened out to the target (including ones that already were). */
  evened: number
  /** Takes left as they were, for any reason below. */
  skipped: number
  /** …because they couldn't be measured (they play at their own volume). */
  unmeasured: number
  /** …because there is nothing in them above the silence gate. */
  silent: number
  /** …because they are gone (deleted, or not in this file any more). */
  gone: number
  /** Evened-out takes that could only go part of the way (the recording's
   *  peak, or the +12 / −20 dB range), and how far short. */
  held: Array<TakeRef & { reason: "peak" | "range"; shortDb: number }>
  /** Takes whose write was refused (left as they were; not in the undo step). */
  failed: number
  /** The person may not even takes out here: nothing was done. */
  notAllowed?: true
  /** The run's undo step (a toast's Undo takes it back); null when nothing changed. */
  stepId?: string | null
}

export interface ClearResult {
  cleared: number
  gone: number
  failed: number
  notAllowed?: true
  /** The clear's undo step; null when nothing changed. */
  stepId?: string | null
}

/**
 * Write the parts as ONE undo step. Each is queued on its own (a refusal
 * skips that take, never the rest), then the outbox is flushed once. The
 * step is recorded as the writes start (an Undo pressed meanwhile waits for
 * them) and, once they end, holds only the takes that were written.
 */
async function applyAsOneStep(host: EvenOutHost, labelKey: string, parts: TakeEvenData[]): Promise<{ failed: number; stepId: string | null }> {
  if (parts.length === 0) return { failed: 0, stepId: null }
  const landed = new Set<string>()
  const key = (d: { cellId: string; audioId: string }) => `${d.cellId}\u0000${d.audioId}`
  let stepId: string | null = null
  const writes = (async () => {
    for (const d of parts) {
      try {
        await host.applyEven(d.cellId, d.audioId, d.after)
        landed.add(key(d))
      } catch {
        // Refused (a role, a lane, the outbox): this take stays as it was.
      }
    }
    if (landed.size > 0) {
      try {
        await host.flush?.()
      } catch {
        // Queued and kept: the outbox sends it when it can.
      }
    }
    if (stepId && landed.size < parts.length) {
      completeStep(stepId, (data) => {
        const d = data as { steps: Array<{ data: TakeEvenData }> }
        return { ...d, steps: d.steps.filter((r) => landed.has(key(r.data))) }
      })
    }
    return landed.size > 0
  })()
  const steps: StepInput<TakeEvenData>[] = parts.map((data) => ({
    kind: "take.even",
    data,
    labelKey,
    fileId: host.fileId ?? null,
    fileName: host.fileName ?? null,
  }))
  // The step is named with its count (board 73: "Even out loudness · 212 takes").
  stepId = recordGroup({ labelKey, labelParams: { count: parts.length }, fileId: host.fileId ?? null, fileName: host.fileName ?? null }, steps, { pending: writes })
  await writes
  return { failed: parts.length - landed.size, stepId: landed.size > 0 ? stepId : null }
}

/** Even out `takes` to the target, measuring any that have no reading yet. */
/** Review M2: runs Even out (and Clear) one at a time, in the order asked. */
export interface EvenOutQueue {
  run<T>(fn: () => Promise<T>, onWaiting?: () => void): Promise<T>
  busy(): boolean
}

export function createEvenOutQueue(): EvenOutQueue {
  let tail: Promise<unknown> = Promise.resolve()
  let running = 0
  return {
    run<T>(fn: () => Promise<T>, onWaiting?: () => void): Promise<T> {
      if (running > 0) onWaiting?.()
      running++
      const go = async () => {
        try {
          return await fn()
        } finally {
          running--
        }
      }
      // Idle: start now. Busy: after the run before it, however it ended.
      const next = running === 1 ? go() : tail.then(go, go)
      tail = next.catch(() => {})
      return next
    },
    busy: () => running > 0,
  }
}

export async function evenOutTakes(host: EvenOutHost, takes: readonly TakeRef[], opts: EvenOutOptions = {}): Promise<EvenOutResult> {
  if (host.queue) return host.queue.run(() => evenOutTakesNow(host, takes, opts), opts.onWaiting)
  return evenOutTakesNow(host, takes, opts)
}

async function evenOutTakesNow(hostIn: EvenOutHost, takes: readonly TakeRef[], opts: EvenOutOptions): Promise<EvenOutResult> {
  // This run's own measurer, when the host makes them (review M2).
  const own = hostIn.newMeasurer?.()
  const host: EvenOutHost = own ? { ...hostIn, measure: own, release: () => own.release() } : hostIn
  const targetLufs = opts.targetLufs ?? DEFAULT_EVEN_TARGET_LUFS
  const result: EvenOutResult = { targetLufs, evened: 0, skipped: 0, unmeasured: 0, silent: 0, gone: 0, held: [], failed: 0 }
  if (host.allowed === false) return { ...result, notAllowed: true }
  const live = takes.filter((t) => {
    if (host.readTake(t.cellId, t.audioId)) return true
    result.gone++
    return false
  })
  // Measure what has no reading, or a reading of another window, one take at
  // a time (one decode in memory).
  // Takes of one recording go together (a stable sort, by recording), so a
  // shared recording — cut pieces, an import's sections — is downloaded and
  // decoded once, however its takes sit among the others.
  const urlOf = (t: TakeRef) => host.readTake(t.cellId, t.audioId)?.url ?? ""
  const toMeasure = live
    .filter((t) => {
      const att = host.readTake(t.cellId, t.audioId)
      return att != null && (att.loudnessLufs == null || readingIsStale(att))
    })
    .map((t, i) => ({ t, i, url: urlOf(t) }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : a.i - b.i))
    .map((x) => x.t)
  try {
    return await evenOutMeasured(host, live, toMeasure, targetLufs, result, opts)
  } finally {
    host.release?.()
  }
}

async function evenOutMeasured(
  host: EvenOutHost,
  live: readonly TakeRef[],
  toMeasure: readonly TakeRef[],
  targetLufs: number,
  result: EvenOutResult,
  opts: EvenOutOptions,
): Promise<EvenOutResult> {
  let done = 0
  if (toMeasure.length > 0) opts.onProgress?.(0, toMeasure.length)
  const readings = new Map<string, LoudnessFields>()
  for (let k = 0; k < toMeasure.length; k++) {
    const t = toMeasure[k]
    if (opts.signal?.aborted) break
    const att = host.readTake(t.cellId, t.audioId)
    if (att) {
      const next = toMeasure[k + 1]
      const last = !next || host.readTake(next.cellId, next.audioId)?.url !== att.url
      try {
        const r = await host.measure(t.cellId, t.audioId, att, opts.signal, { last })
        if (r) readings.set(`${t.cellId}\u0000${t.audioId}`, r)
      } catch {
        // The fallback: an unmeasured take is skipped below.
      }
    }
    opts.onProgress?.(++done, toMeasure.length)
  }
  const parts: TakeEvenData[] = []
  for (const t of live) {
    const att = host.readTake(t.cellId, t.audioId)
    if (!att) {
      result.gone++
      continue
    }
    // A fresh reading wins over a stale one; a stale one that couldn't be
    // refreshed still serves.
    const reading = readings.get(`${t.cellId}\u0000${t.audioId}`) ?? null
    const loudness = reading?.loudnessLufs ?? att.loudnessLufs ?? null
    if (loudness == null) {
      result.unmeasured++
      continue
    }
    if (loudness <= SILENT_LUFS) {
      result.silent++
      continue
    }
    const before = att.evenTargetLufs ?? null
    const g = evenOutCorrection({ ...att, ...(reading ?? {}), evenTargetLufs: targetLufs })
    if (g.held) result.held.push({ ...t, reason: g.held, shortDb: Math.round((g.wantedDb - g.correctionDb) * 10) / 10 })
    result.evened++
    if (before !== targetLufs) parts.push({ ...t, before, after: targetLufs, ...(opts.markAsRun ? { run: true as const } : {}) })
  }
  const written = await applyAsOneStep(host, "editor.history.stepEvenOut", parts)
  result.failed = written.failed
  result.stepId = written.stepId
  result.evened -= result.failed
  result.skipped = result.unmeasured + result.silent + result.gone
  return result
}

/** Take evening out off `takes`: each plays at its own volume again. */
export async function clearEvenOut(host: EvenOutHost, takes: readonly TakeRef[], opts: { onWaiting?: () => void } = {}): Promise<ClearResult> {
  if (host.queue) return host.queue.run(() => clearEvenOutNow(host, takes), opts.onWaiting)
  return clearEvenOutNow(host, takes)
}

async function clearEvenOutNow(host: EvenOutHost, takes: readonly TakeRef[]): Promise<ClearResult> {
  if (host.allowed === false) return { cleared: 0, gone: 0, failed: 0, notAllowed: true }
  let gone = 0
  const parts: TakeEvenData[] = []
  for (const t of takes) {
    const att = host.readTake(t.cellId, t.audioId)
    if (!att) {
      gone++
      continue
    }
    const before = att.evenTargetLufs ?? null
    if (before == null) continue
    parts.push({ ...t, before, after: null })
  }
  const { failed, stepId } = await applyAsOneStep(host, "editor.history.stepClearEvenOut", parts)
  return { cleared: parts.length - failed, gone, failed, stepId }
}

/**
 * The takes an action over a file, a track or several tracks covers: every
 * live recorded or generated take (not only the chosen one, so switching
 * takes later stays even), on the given tracks (slots) or all of them. The
 * film's own sound (`role: "source"`) is never evened out.
 */
export function takesToEvenOut(cells: readonly CellData[], opts: { slots?: readonly string[] } = {}): TakeRef[] {
  const slots = opts.slots ? new Set(opts.slots) : null
  const out: TakeRef[] = []
  for (const c of cells) {
    for (const [audioId, a] of Object.entries(c.attachments ?? {})) {
      if (!a || a.isDeleted || a.role === "source") continue
      if (a.type && !a.type.startsWith("audio")) continue
      if (slots && !slots.has(a.slot ?? "recording")) continue
      out.push({ cellId: c.id, audioId })
    }
  }
  return out
}

/** Each live take in `cells` (on `slots`, or all), with its attachment. */
function* liveTakes(cells: readonly CellData[], slots: readonly string[] | undefined): Generator<[TakeRef, CodexCellAttachment]> {
  const only = slots ? new Set(slots) : null
  for (const c of cells) {
    for (const [audioId, a] of Object.entries(c.attachments ?? {})) {
      if (!a || a.isDeleted || a.role === "source") continue
      if (a.type && !a.type.startsWith("audio")) continue
      if (only && !only.has(a.slot ?? "recording")) continue
      yield [{ cellId: c.id, audioId }, a]
    }
  }
}

/**
 * A track's ≈ (board 74): "none" while the track has no takes or any take on
 * it isn't evened out; "full" when every one is; "part" when every one is and
 * at least one couldn't go all the way (take-gain's `held`, drawn amber).
 */
export function evenStateOf(cells: readonly CellData[], slots: readonly string[]): "none" | "full" | "part" {
  let any = false
  let held = false
  for (const [, a] of liveTakes(cells, slots)) {
    if (a.evenTargetLufs == null) return "none"
    any = true
    if (!held && evenOutCorrection(a).held) held = true
  }
  return !any ? "none" : held ? "part" : "full"
}

/** The evened takes a Clear over these tracks (or the file) would take back. */
export function evenedTakesIn(cells: readonly CellData[], opts: { slots?: readonly string[] } = {}): TakeRef[] {
  const out: TakeRef[] = []
  for (const [ref, a] of liveTakes(cells, opts.slots)) if (a.evenTargetLufs != null) out.push(ref)
  return out
}

/**
 * QUESTION 89 (settled Nov 19: ON): an evened track stays even. New, cut and
 * trimmed takes on an evened track are evened out quietly in the background,
 * measured the same way (worker or yielding page meter), one undo step per
 * batch; each shows ≈ and can be cleared in the Station. Read in one place —
 * ProjectWorkspace hands it to the auto-even queue (auto-even-queue.ts), which
 * starts only from this tab's own actions on a take (review M1).
 *
 * Fallback: a take that can't be measured plays at its own volume, as any
 * unmeasured take does.
 */
export const AUTO_EVEN_CHANGED_TAKES = true

/**
 * Of the takes THIS TAB just made or changed (review M1: never every take
 * that merely looks un-evened), the ones auto-even evens. The rule needs no
 * new state (re-check, Sam):
 * - a NEW take (`kind: "new"`: recorded, attached, a version, Remove noise)
 *   with no target, on a track (slot) where some take is evened out;
 * - a CUT or TRIMMED take (`kind: "changed"`) only if it already HAD a
 *   target and its reading is now of another window. A cleared take has no
 *   target, so a later trim or cut leaves it cleared.
 * A new take that inherited its target (a version) is measured when it is
 * made, so it is left alone. None when `enabled` is off.
 */
export function autoEvenCandidates(
  cells: readonly CellData[],
  refs: ReadonlyArray<TakeRef & { kind: "new" | "changed" }>,
  enabled: boolean,
): TakeRef[] {
  if (!enabled || refs.length === 0) return []
  const evenedSlots = new Set<string>()
  for (const [, a] of liveTakes(cells, undefined)) if (a.evenTargetLufs != null) evenedSlots.add(a.slot ?? "recording")
  const kindOf = new Map(refs.map((r) => [`${r.cellId}\u0000${r.audioId}`, r.kind] as const))
  const out: TakeRef[] = []
  for (const [ref, a] of liveTakes(cells, undefined)) {
    const kind = kindOf.get(`${ref.cellId}\u0000${ref.audioId}`)
    if (!kind) continue
    const wanted = kind === "new"
      ? a.evenTargetLufs == null && evenedSlots.has(a.slot ?? "recording")
      : a.evenTargetLufs != null && readingIsStale(a)
    if (wanted) out.push(ref)
  }
  return out
}

/** About what this device can decode at once: the AQU-1857 budget. */
export const MEASURE_PCM_BUDGET_BYTES = 384 * 1024 * 1024
/** A take whose bytes and decode take longer than this is skipped. */
export const MEASURE_TIMEOUT_MS = 60_000
/** Mono float PCM at 48 kHz, bytes per second. */
const PCM_BYTES_PER_SEC = TARGET_RATE * 4
/**
 * A recording of unknown length is assumed to decode to at most this many
 * times its stored size: about what 32 kbps Opus expands to as 48 kHz float.
 * Generous on purpose, so a long take of unknown length never slips past the
 * budget.
 */
const WORST_EXPANSION = 48

export interface TakeMeasurerDeps {
  /** The take's stored bytes (the bytes cache / sync worker). Honour `signal`. */
  fetchBytes(att: CodexCellAttachment, where: TakeRef, signal?: AbortSignal): Promise<Uint8Array>
  /** The whole recording as mono PCM at 48 kHz (decode-mono.ts `decodeToMono48k`). */
  decode(bytes: Uint8Array): Promise<Float32Array>
  /**
   * Just a part of a recording too long to decode whole, as mono PCM at
   * 48 kHz (the AQU-1857 minute-at-a-time MP3 walk: `decodeMp3Window`). Null
   * when this recording can't be decoded in parts (not an MP3).
   */
  decodeWindow?(bytes: Uint8Array, startSec: number, endSec: number): Promise<Float32Array | null>
  /** Store the reading (emitCellAudioMeasure + an optimistic overlay). */
  /** `durationMs`: the take's length when known (its own, else the decode's), null when not. */
  emit(cellId: string, audioId: string, reading: LoudnessFields, durationMs: number | null): Promise<void>
  /** The meter. Default: off the page in the loudness worker, else on the
   *  page in yielding chunks (loudness-client.ts). It may take the samples. */
  meter?: (pcm: Float32Array, rate: number, signal?: AbortSignal) => Promise<LoudnessReading>
  pcmBudgetBytes?: number
  timeoutMs?: number
}

/** One recording, fetched (and, when it fits, decoded) once for all its takes. */
interface HeldRecording {
  url: string
  bytes: Uint8Array
  /** The whole decode, when it fits the budget; null = decode in parts. */
  pcm: Float32Array | null
}

/**
 * The measuring behind {@link EvenOutHost.measure}. Each take is measured
 * over ITS OWN WINDOW of the recording (Sam, Nov 19): a cut take's pieces
 * and a shared import's sections each get their own reading. The recording
 * they share is fetched once and, when it fits this device's memory budget,
 * decoded once; a longer one is decoded only around each section (MP3, the
 * AQU-1857 walk). Every failure — fetch, decode, timeout, Cancel, a part too
 * long for the budget, a long recording that can't be decoded in parts — is
 * a null, never a throw: the take is then skipped and plays at its own volume.
 */
export type TakeMeasurer = EvenOutHost["measure"] & { release(): void }

export function makeTakeMeasurer(deps: TakeMeasurerDeps): TakeMeasurer {
  const budget = deps.pcmBudgetBytes ?? MEASURE_PCM_BUDGET_BYTES
  const timeoutMs = deps.timeoutMs ?? MEASURE_TIMEOUT_MS
  const meter = deps.meter ?? ((pcm: Float32Array, rate: number, signal?: AbortSignal) => loudnessClient().measure([pcm], rate, signal))
  // One recording at a time (one decode in memory).
  let held: HeldRecording | null = null
  const results = new Map<string, { reading: LoudnessFields; durationMs: number | null }>()
  // Recordings whose download failed or ran out of time this run: their
  // other takes are skipped at once instead of downloading again.
  const failed = new Set<string>()

  const windowOf = (att: CodexCellAttachment): { startSec: number; endSec: number | null } => ({
    startSec: Math.max(0, (att.trimStartMs ?? 0) / 1000),
    endSec: att.trimEndMs != null ? att.trimEndMs / 1000 : null,
  })

  const recordingFor = async (att: CodexCellAttachment, where: TakeRef, signal: AbortSignal): Promise<HeldRecording | null> => {
    if (held?.url === att.url) return held
    held = null
    let bytes: Uint8Array
    try {
      bytes = await deps.fetchBytes(att, where, signal)
    } catch (e) {
      failed.add(att.url)
      throw e
    }
    if (signal.aborted) return null
    const decodedBytes = att.durationMs != null ? (att.durationMs / 1000) * PCM_BYTES_PER_SEC : bytes.length * WORST_EXPANSION
    const pcm = decodedBytes <= budget ? await deps.decode(bytes) : null
    if (signal.aborted) return null
    held = { url: att.url, bytes, pcm }
    return held
  }

  const run = async (where: TakeRef, att: CodexCellAttachment, signal: AbortSignal, last: boolean): Promise<{ reading: LoudnessFields; durationMs: number | null } | null> => {
    const { startSec, endSec } = windowOf(att)
    // A part too long for this device's memory: don't fetch anything.
    const knownEnd = endSec ?? (att.durationMs != null ? att.durationMs / 1000 : null)
    if (knownEnd != null && (knownEnd - startSec) * PCM_BYTES_PER_SEC > budget) return null
    const rec = await recordingFor(att, where, signal)
    if (!rec) return null
    let part: Float32Array | null
    let durationMs: number | null
    if (rec.pcm) {
      durationMs = Math.round((rec.pcm.length / TARGET_RATE) * 1000)
      const a = Math.min(rec.pcm.length, Math.round(startSec * TARGET_RATE))
      const b = endSec != null ? Math.min(rec.pcm.length, Math.round(endSec * TARGET_RATE)) : rec.pcm.length
      if (last) {
        // Nothing later needs the decode: meter it in place (the worker may
        // take it) and let it go — no second copy in memory.
        part = a === 0 && b === rec.pcm.length ? rec.pcm : rec.pcm.subarray(a, Math.max(a, b))
        held = null
      } else {
        // A copy: the meter may take (transfer) it, and the decode stays for
        // the recording's next section.
        part = rec.pcm.slice(a, Math.max(a, b))
      }
    } else {
      // Too long to decode whole: just this part, if the recording allows it.
      if (knownEnd == null || !deps.decodeWindow) return null
      part = await deps.decodeWindow(rec.bytes, startSec, knownEnd)
      durationMs = att.durationMs ?? null
    }
    // No samples (a detached or empty decode) is not silence: store nothing
    // rather than a −70 LUFS reading (review M2).
    if (!part || part.length === 0 || signal.aborted) return null
    // Cancel and the timeout stop the meter too, not just the download.
    const r = await meter(part, TARGET_RATE, signal)
    if (signal.aborted) return null
    return {
      reading: { loudnessLufs: r.integratedLufs, truePeakDb: r.truePeakDb, loudnessFromMs: att.trimStartMs ?? 0, loudnessToMs: att.trimEndMs ?? null },
      durationMs,
    }
  }

  const measure = async (cellId: string, audioId: string, att: CodexCellAttachment, signal?: AbortSignal, mopts?: MeasureOptions): Promise<LoudnessFields | null> => {
    if (failed.has(att.url)) return null
    const key = `${att.url}\u0000${att.trimStartMs ?? 0}\u0000${att.trimEndMs ?? ""}`
    const hit = results.get(key)
    let reading = hit?.reading ?? null
    let durationMs: number | null = att.durationMs ?? hit?.durationMs ?? null
    if (!reading) {
      // Its own controller: Cancel and the timeout both stop the download,
      // and nothing is decoded or metered after either.
      const ac = new AbortController()
      const cancel = () => ac.abort()
      if (signal?.aborted) return null
      signal?.addEventListener("abort", cancel, { once: true })
      const timer = setTimeout(cancel, timeoutMs)
      try {
        // Settles on abort too, even if a download ignores its signal.
        const aborted = new Promise<null>((resolve) => ac.signal.addEventListener("abort", () => resolve(null), { once: true }))
        const m = await Promise.race([run({ cellId, audioId }, att, ac.signal, mopts?.last ?? false).catch(() => null), aborted])
        if (!m) {
          // Ran out of time (not Cancel): this recording is skipped for the
          // rest of the run. Nothing outlives the run: the next one may have
          // a better network.
          if (ac.signal.aborted) {
            if (!signal?.aborted && held?.url !== att.url) failed.add(att.url)
            held = null
          }
          return null
        }
        reading = m.reading
        if (!durationMs) durationMs = m.durationMs
        results.set(key, { reading, durationMs: m.durationMs })
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", cancel)
      }
    }
    try {
      await deps.emit(cellId, audioId, reading, durationMs && durationMs > 0 ? durationMs : null)
    } catch {
      // Not saved (the outbox refused it): it still counts in this session,
      // and the take is measured again next time.
    }
    return reading
  }
  return Object.assign(measure, {
    release() {
      held = null
      failed.clear()
      results.clear()
    },
  })
}
