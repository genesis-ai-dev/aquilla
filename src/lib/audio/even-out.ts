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

import { recordGroup, type StepInput } from "@/lib/history/history"
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
}

/** What the actions need from the workspace. */
export interface EvenOutHost {
  /** The take as it reads now (null when gone or deleted). */
  readTake(cellId: string, audioId: string): CodexCellAttachment | null
  /** The workspace's evening-out write (ProjectWorkspace `applyTakeEven`): one
   *  `cell.audio.even` with the target (null clears), overlay and flush. */
  applyEven(cellId: string, audioId: string, targetLufs: number | null): Promise<void>
  /** Measure a take that has no reading (see makeTakeMeasurer); null = couldn't. */
  measure(cellId: string, audioId: string, att: CodexCellAttachment, signal?: AbortSignal): Promise<LoudnessFields | null>
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
}

/** Write the parts as ONE undo step, recorded as the writes start. */
async function applyAsOneStep(
  host: EvenOutHost,
  labelKey: string,
  parts: TakeEvenData[],
): Promise<void> {
  if (parts.length === 0) return
  const writes = (async () => {
    for (const d of parts) await host.applyEven(d.cellId, d.audioId, d.after)
    return true
  })()
  const steps: StepInput<TakeEvenData>[] = parts.map((data) => ({
    kind: "take.even",
    data,
    labelKey,
    fileId: host.fileId ?? null,
    fileName: host.fileName ?? null,
  }))
  recordGroup({ labelKey, fileId: host.fileId ?? null, fileName: host.fileName ?? null }, steps, { pending: writes })
  await writes
}

/** Even out `takes` to the target, measuring any that have no reading yet. */
export async function evenOutTakes(host: EvenOutHost, takes: readonly TakeRef[], opts: EvenOutOptions = {}): Promise<EvenOutResult> {
  const targetLufs = opts.targetLufs ?? DEFAULT_EVEN_TARGET_LUFS
  const result: EvenOutResult = { targetLufs, evened: 0, skipped: 0, unmeasured: 0, silent: 0, gone: 0, held: [] }
  const live = takes.filter((t) => {
    if (host.readTake(t.cellId, t.audioId)) return true
    result.gone++
    return false
  })
  // Measure what has no reading, one take at a time (one decode in memory).
  const toMeasure = live.filter((t) => host.readTake(t.cellId, t.audioId)?.loudnessLufs == null)
  let done = 0
  if (toMeasure.length > 0) opts.onProgress?.(0, toMeasure.length)
  const readings = new Map<string, LoudnessFields>()
  for (const t of toMeasure) {
    if (opts.signal?.aborted) break
    const att = host.readTake(t.cellId, t.audioId)
    if (att) {
      try {
        const r = await host.measure(t.cellId, t.audioId, att, opts.signal)
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
    const reading = att.loudnessLufs != null ? null : readings.get(`${t.cellId}\u0000${t.audioId}`)
    const loudness = att.loudnessLufs ?? reading?.loudnessLufs ?? null
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
    if (before !== targetLufs) parts.push({ ...t, before, after: targetLufs })
  }
  result.skipped = result.unmeasured + result.silent + result.gone
  await applyAsOneStep(host, "editor.history.stepEvenOut", parts)
  return result
}

/** Take evening out off `takes`: each plays at its own volume again. */
export async function clearEvenOut(host: EvenOutHost, takes: readonly TakeRef[]): Promise<{ cleared: number; gone: number }> {
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
  await applyAsOneStep(host, "editor.history.stepClearEvenOut", parts)
  return { cleared: parts.length, gone }
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

/** About what this device can decode at once: the AQU-1857 budget. */
export const MEASURE_PCM_BUDGET_BYTES = 384 * 1024 * 1024
/** A take whose bytes and decode take longer than this is skipped. */
export const MEASURE_TIMEOUT_MS = 60_000

export interface TakeMeasurerDeps {
  /** The take's stored bytes (the bytes cache / sync worker). */
  fetchBytes(att: CodexCellAttachment, where: TakeRef, signal?: AbortSignal): Promise<Uint8Array>
  /** Mono PCM at 48 kHz (decode-mono.ts `decodeToMono48k`). */
  decode(bytes: Uint8Array): Promise<Float32Array>
  /** Store the reading (emitCellAudioMeasure + an optimistic overlay). */
  emit(cellId: string, audioId: string, reading: LoudnessFields, durationMs: number): Promise<void>
  /** The meter. Default: off the page in the loudness worker, else on the
   *  page in yielding chunks (loudness-client.ts). It may take the samples. */
  meter?: (pcm: Float32Array, rate: number) => Promise<LoudnessReading>
  pcmBudgetBytes?: number
  timeoutMs?: number
}

/**
 * The measuring behind {@link EvenOutHost.measure}. A recording shared by
 * several takes (a cut take's pieces, an imported clip) is measured once.
 * Every failure is a null, never a throw: the take is then skipped.
 */
export function makeTakeMeasurer(deps: TakeMeasurerDeps): EvenOutHost["measure"] {
  const byUrl = new Map<string, Promise<{ reading: LoudnessFields; durationMs: number } | null>>()
  const budget = deps.pcmBudgetBytes ?? MEASURE_PCM_BUDGET_BYTES
  const timeoutMs = deps.timeoutMs ?? MEASURE_TIMEOUT_MS
  const meter = deps.meter ?? ((pcm: Float32Array, rate: number) => loudnessClient().measure([pcm], rate))
  const run = async (where: TakeRef, att: CodexCellAttachment, signal?: AbortSignal): Promise<{ reading: LoudnessFields; durationMs: number } | null> => {
    // Too long for this device's memory: don't fetch it at all.
    if (att.durationMs != null && (att.durationMs / 1000) * TARGET_RATE * 4 > budget) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
    const work = (async () => {
      const bytes = await deps.fetchBytes(att, where, signal)
      if (signal?.aborted) return null
      const pcm = await deps.decode(bytes)
      // Read before the meter: the worker path transfers the samples away.
      const durationMs = Math.round((pcm.length / TARGET_RATE) * 1000)
      const r = await meter(pcm, TARGET_RATE)
      return { reading: { loudnessLufs: r.integratedLufs, truePeakDb: r.truePeakDb }, durationMs }
    })().catch(() => null)
    try {
      return await Promise.race([work, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
  return async (cellId, audioId, att, signal) => {
    const key = att.url || `${cellId}\u0000${audioId}`
    let pending = byUrl.get(key)
    if (!pending) {
      pending = run({ cellId, audioId }, att, signal)
      byUrl.set(key, pending)
    }
    const m = await pending
    // A failure is not remembered: the next run may have a better network.
    if (!m) {
      byUrl.delete(key)
      return null
    }
    try {
      await deps.emit(cellId, audioId, m.reading, att.durationMs ?? m.durationMs)
    } catch {
      // Not saved (the outbox refused it): it still counts in this session,
      // and the take is measured again next time.
    }
    return m.reading
  }
}
