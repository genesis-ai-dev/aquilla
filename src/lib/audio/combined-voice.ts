// "Voice together": synthesize several selected cells as ONE continuous TTS
// clip (better prosody than gluing separate takes), then make each cell play
// its slice of that one clip.
//
// How it works:
//   1. Join the selected cells' target text (in document order) with a pause
//      separator and synthesize ONE clip in a single TTS call.
//   2. Upload the clip once to R2 (one object, audioId.ext — keys aren't
//      cell-scoped, so one object can back many cells).
//   3. Attach that same audioId/url to every selected cell (generatedVoice).
//   4. Detect per-cell boundaries inside the clip (proportional by text length,
//      snapped to detected silence gaps) and store each cell's [start,end] as
//      its trim in audio-cell-prefs — so the per-cell player (which already
//      honours trim) plays just that cell's portion.
//
// Boundaries live client-side (localStorage trim), same as crop. The clip
// itself persists server-side via the attachment.

import { synthesizeForCell, setTtsStatus, ttsStatusKey } from "./tts"
import { resolveCastVoice } from "./voices"
import { buildAudioId, uploadCellAudio, fetchCellAudio } from "./upload"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { convertToCloneVoice } from "./voice-clone"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import { notifyAudioAttachmentsChanged } from "./audio-attachments-bus"
import { setCellPref } from "@/lib/store/audio-cell-prefs"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

/** Keep the joined request a single, sane TTS call. */
export const MAX_COMBINED_CELLS = 12
export const MAX_COMBINED_CHARS = 2000

/** Pause-inducing separator between cells in the joined text. */
const SEPARATOR = "\n\n"

export interface CombinedVoiceArgs {
  project: ProjectRecord
  fileId: string
  /** Selected cells, already in document order. */
  cells: CellData[]
  settings?: ProjectTtsSettings
  session: FrontierSession | null
  username: string
  onProgress?: (msg: string) => void
}

export interface CombinedVoiceResult {
  audioId: string
  cellCount: number
  /** True if the selection was capped (too many cells / too much text). */
  truncated: boolean
}

const AudioCtxCtor =
  typeof window !== "undefined"
    ? (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
    : null

/** Decode an audio blob to mono Float32 PCM for silence analysis. */
async function decodeToMonoPcm(
  blob: Blob,
): Promise<{ samples: Float32Array; sampleRate: number; duration: number } | null> {
  if (!AudioCtxCtor) return null
  try {
    const buf = await blob.arrayBuffer()
    const ctx = new AudioCtxCtor()
    let audioBuf: AudioBuffer
    try {
      audioBuf = await ctx.decodeAudioData(buf)
    } finally {
      void ctx.close()
    }
    const chans = audioBuf.numberOfChannels
    if (chans === 1) {
      return { samples: audioBuf.getChannelData(0).slice(), sampleRate: audioBuf.sampleRate, duration: audioBuf.duration }
    }
    const len = audioBuf.length
    const mono = new Float32Array(len)
    const data: Float32Array[] = []
    for (let c = 0; c < chans; c++) data.push(audioBuf.getChannelData(c))
    for (let i = 0; i < len; i++) {
      let sum = 0
      for (let c = 0; c < chans; c++) sum += data[c][i]
      mono[i] = sum / chans
    }
    return { samples: mono, sampleRate: audioBuf.sampleRate, duration: audioBuf.duration }
  } catch {
    return null
  }
}

interface Silence { center: number; length: number }

/** RMS-window scan → list of silence regions + the speech span. */
function analyzeSilence(samples: Float32Array, sampleRate: number): {
  silences: Silence[]
  speechStart: number
  speechEnd: number
} {
  const win = Math.max(1, Math.floor(sampleRate * 0.02)) // 20 ms windows
  const count = Math.floor(samples.length / win)
  const rms = new Float32Array(count)
  let maxRms = 0
  for (let i = 0; i < count; i++) {
    let acc = 0
    const base = i * win
    for (let j = 0; j < win; j++) { const s = samples[base + j]; acc += s * s }
    const r = Math.sqrt(acc / win)
    rms[i] = r
    if (r > maxRms) maxRms = r
  }
  const thresh = Math.max(0.015, maxRms * 0.1)
  const tOf = (winIdx: number) => (winIdx * win) / sampleRate

  let speechStart = 0
  let speechEnd = count > 0 ? tOf(count) : 0
  for (let i = 0; i < count; i++) { if (rms[i] > thresh) { speechStart = tOf(i); break } }
  for (let i = count - 1; i >= 0; i--) { if (rms[i] > thresh) { speechEnd = tOf(i + 1); break } }

  const silences: Silence[] = []
  let runStart = -1
  for (let i = 0; i <= count; i++) {
    const quiet = i < count && rms[i] <= thresh
    if (quiet && runStart < 0) runStart = i
    else if (!quiet && runStart >= 0) {
      const s = tOf(runStart)
      const e = tOf(i)
      if (e - s >= 0.12) silences.push({ center: (s + e) / 2, length: e - s })
      runStart = -1
    }
  }
  return { silences, speechStart, speechEnd }
}

/** Per-cell [start,end] windows: proportional by text length, snapped to
 *  nearby silence gaps when available. */
function computeBoundaries(
  charLens: number[],
  duration: number,
  analysis: { silences: Silence[]; speechStart: number; speechEnd: number } | null,
): { start: number; end: number }[] {
  const n = charLens.length
  if (n === 1) return [{ start: 0, end: duration }]
  const total = charLens.reduce((a, b) => a + b, 0) || n
  const lo = analysis ? Math.max(0, Math.min(analysis.speechStart, duration)) : 0
  const hi = analysis ? Math.max(lo + 0.1, Math.min(analysis.speechEnd, duration)) : duration
  const span = hi - lo

  // Internal silence gaps eligible for snapping.
  const gaps = (analysis?.silences ?? []).filter((g) => g.center > lo + 0.05 && g.center < hi - 0.05)

  let cum = 0
  const cuts: number[] = []
  for (let i = 0; i < n - 1; i++) {
    cum += charLens[i]
    let cut = lo + span * (cum / total)
    // Snap to the nearest silence centre within 0.6s, if any.
    let best = -1
    let bestDist = 0.6
    for (let g = 0; g < gaps.length; g++) {
      const d = Math.abs(gaps[g].center - cut)
      if (d < bestDist) { bestDist = d; best = g }
    }
    if (best >= 0) cut = gaps[best].center
    // Keep strictly increasing.
    const prev = cuts.length ? cuts[cuts.length - 1] : 0
    if (cut <= prev + 0.05) cut = Math.min(prev + 0.05, duration)
    cuts.push(cut)
  }

  const windows: { start: number; end: number }[] = []
  for (let i = 0; i < n; i++) {
    const start = i === 0 ? 0 : cuts[i - 1]
    const end = i === n - 1 ? duration : cuts[i]
    windows.push({ start: Math.max(0, start), end: Math.min(duration, Math.max(start + 0.05, end)) })
  }
  return windows
}

/**
 * Synthesize the selected cells as one clip and wire each cell to its slice.
 * Returns the shared audioId + how many cells were voiced.
 */
export async function generateCombinedVoice(args: CombinedVoiceArgs): Promise<CombinedVoiceResult> {
  const { project, fileId, settings, session, username, onProgress } = args
  if (!session?.jwt) throw new Error("Sign in to generate audio")

  // Selectable cells in document order: translated, non-paratext.
  const ordered = args.cells.filter((c) => c.type !== "paratext" && c.translated?.trim())
  if (ordered.length < 2) throw new Error("Select at least two translated lines to voice together")

  // Cap to one sane request (by cell count and total chars).
  const chosen: CellData[] = []
  let chars = 0
  let truncated = false
  for (const c of ordered) {
    const t = c.translated.trim()
    if (chosen.length >= MAX_COMBINED_CELLS || (chosen.length > 0 && chars + t.length > MAX_COMBINED_CHARS)) {
      truncated = true
      break
    }
    chosen.push(c)
    chars += t.length
  }
  if (chosen.length < 2) throw new Error("Selected lines are too long to voice together")

  const statusKeys = chosen.map((c) => ttsStatusKey(c.id))
  const setAll = (s: Parameters<typeof setTtsStatus>[1]) => { for (const k of statusKeys) setTtsStatus(k, s) }

  const voice = resolveCastVoice(settings, chosen[0].id)
  const parts = chosen.map((c) => c.translated.trim())
  const joined = parts.join(SEPARATOR)
  const getSyncToken = audioSyncTokenFetcherForSession(session)

  setAll({ kind: "synthesizing" })
  try {
    onProgress?.("Synthesizing combined clip…")
    const ttsBlob = await synthesizeForCell(joined, {
      projectTtsSettings: settings,
      cellVoiceId: voice.id,
      geminiContext: {
        sourceLanguage: project.sourceLanguage,
        targetLanguage: project.targetLanguage,
        original: chosen[0].original,
        context: chosen[0].context,
        cellLabel: chosen[0].cellLabel,
      },
      onProgress: (p) => setAll(
        p.status === "ready" || (p.total > 0 && p.loaded >= p.total)
          ? { kind: "synthesizing" }
          : { kind: "loading", loaded: p.loaded, total: p.total, file: p.file },
      ),
    })

    // Upload once (clone-revoice the whole clip if the voice is a clone).
    let audioId: string
    let ext: string
    let url: string
    let playable: Blob
    if (voice.referenceAudioId) {
      onProgress?.("Applying voice clone…")
      const conv = await convertToCloneVoice({
        projectId: project.id,
        fileId,
        referenceAudioId: voice.referenceAudioId,
        source: ttsBlob,
        getSyncToken,
      })
      audioId = conv.audioId
      ext = conv.ext
      url = conv.url
      const bytes = await fetchCellAudio({ projectId: project.id, fileId, audioId: conv.audioId, ext: conv.ext, getSyncToken })
      playable = new Blob([bytes as BlobPart], { type: "audio/wav" })
    } else {
      const baseId = buildAudioId(chosen[0].id)
      ext = "wav"
      const res = await uploadCellAudio({ projectId: project.id, fileId, audioId: baseId, ext, blob: ttsBlob, getSyncToken })
      audioId = res.audioId
      url = res.url
      playable = ttsBlob
    }
    const objectName = `${audioId}.${ext}`

    // Detect per-cell boundaries inside the clip.
    onProgress?.("Splitting by line…")
    const decoded = await decodeToMonoPcm(playable)
    const duration = decoded?.duration ?? 0
    const windows = duration > 0
      ? computeBoundaries(parts.map((p) => p.length), duration, decoded ? analyzeSilence(decoded.samples, decoded.sampleRate) : null)
      : chosen.map(() => null)

    // Attach the shared clip to every cell + store its slice as trim.
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i]
      await emitCellAudioAttach({
        projectId: project.id,
        fileId,
        cellId: c.id,
        audioId: objectName,
        url,
        slot: "generatedVoice",
        mimeType: "audio/wav",
        voiceId: voice.id,
        ...(voice.referenceAudioId ? { referenceAudioId: voice.referenceAudioId } : {}),
        author: username,
      })
      const w = windows[i]
      setCellPref(project.id, c.id, {
        trimStart: w ? w.start : undefined,
        trimEnd: w ? w.end : undefined,
      })
    }
    notifyAudioAttachmentsChanged(fileId)
    setAll({ kind: "idle" })
    return { audioId: objectName, cellCount: chosen.length, truncated }
  } catch (e) {
    setAll({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    throw e
  }
}
