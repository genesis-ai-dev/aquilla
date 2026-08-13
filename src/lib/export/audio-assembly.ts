/**
 * Audio assembly for org data egress — turns one file's cells into audio zip
 * entries for a chosen EgressAudioMode. Pure orchestration over injected
 * fetch/decode (Web Audio is browser-only; tests pass fakes), mirroring the
 * audio-by-character DI seam.
 */

import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import type { EgressAudioMode } from "@/lib/egress/types"
import { resolveCastVoice } from "@/lib/audio/voices"
import { parseFrontierAudioUrl } from "@/lib/audio/upload"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"
import { TARGET_RATE } from "@/lib/audio/decode-mono"
import { audioMimeForExt } from "@/lib/audio/mime"
import { characterKey, concatPcm } from "@/lib/export/audio-by-character"

export type AudioAssemblyMode = Exclude<EgressAudioMode, "none">

export interface AudioAssemblyArgs {
  cells: CellData[]
  settings: ProjectTtsSettings | undefined
  projectId: string
  /** Filesystem-safe base for entry names (the file's slug). */
  fileSlug: string
  langCode: string
  mode: AudioAssemblyMode
  /** Fetch raw bytes for one clip (cache-first in production). */
  fetchBytes: (args: {
    projectId: string
    fileId: string
    audioId: string
    ext: string
  }) => Promise<Uint8Array>
  /** Decode bytes → mono PCM at 48 kHz (production: decodeToMono48k). */
  decode: (bytes: Uint8Array) => Promise<Float32Array>
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface AudioAssemblyResult {
  /** Entry names are relative — the engine prefixes project/lane/file dirs. */
  entries: { name: string; data: Blob }[]
  skipped: { cellId: string; reason: string }[]
}

/** Slice a clip's non-destructive trim window (AQU-646) out of decoded PCM.
 *  Windows clamp to the clip; an inverted window is empty. Returns the input
 *  array untouched when there is nothing to trim, so shared full-length clips
 *  aren't copied per cell. */
export function applyTrimPcm(
  pcm: Float32Array,
  rate: number,
  trimStartMs?: number | null,
  trimEndMs?: number | null,
): Float32Array {
  const start = Math.min(pcm.length, Math.max(0, Math.round(((trimStartMs ?? 0) / 1000) * rate)))
  const end =
    trimEndMs == null
      ? pcm.length
      : Math.min(pcm.length, Math.max(start, Math.round((trimEndMs / 1000) * rate)))
  if (start === 0 && end === pcm.length) return pcm
  return pcm.slice(start, end)
}

// ─── Timeline (voice-timeline mode) ──────────────────────────────────────────

export interface TimelineClip {
  cellId: string
  voiceId: string
  /** Post-trim PCM at TARGET_RATE. */
  pcm: Float32Array
}

export interface TimelinePlacement extends TimelineClip {
  /** Sample offset on the shared timeline. */
  offset: number
}

export interface Timeline {
  totalSamples: number
  placements: TimelinePlacement[]
}

/** Cumulative document-order offsets: every clip occupies its own span on ONE
 *  shared timeline, so per-voice stems line up sample-for-sample in a DAW. */
export function buildTimeline(clips: TimelineClip[]): Timeline {
  const placements: TimelinePlacement[] = []
  let offset = 0
  for (const clip of clips) {
    placements.push({ ...clip, offset })
    offset += clip.pcm.length
  }
  return { totalSamples: offset, placements }
}

/** One voice's stem: its clips at their offsets, zero-filled silence while
 *  other voices speak. Every stem is totalSamples long — identical length
 *  across voices, which is what makes the tracks droppable as a set. */
export function writeTimelineTrack(timeline: Timeline, voiceId: string): Float32Array {
  const track = new Float32Array(timeline.totalSamples)
  for (const p of timeline.placements) {
    if (p.voiceId === voiceId) track.set(p.pcm, p.offset)
  }
  return track
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

interface ResolvedClip {
  cell: CellData
  /** Position in the cells array (document order) — the `<nnn>` prefix. */
  docIndex: number
  attachment: CodexCellAttachment
  /** Attachment key on the cell (recording slot or generated-voice slot). */
  attachedId: string
  audioId: string
  ext: string
  /** Fetch/decode dedupe key — combined-voice clips repeat across cells. */
  clipKey: string
  voice: Voice
  trimmed: boolean
}

export async function assembleAudioEntries(args: AudioAssemblyArgs): Promise<AudioAssemblyResult> {
  const entries: AudioAssemblyResult["entries"] = []
  const skipped: AudioAssemblyResult["skipped"] = []

  // Clip selection mirrors audio-by-character: recording slot first, then the
  // generated-voice slot. Cells without usable audio are recorded, never
  // silently dropped — the manifest is the transparency contract.
  const resolved: ResolvedClip[] = []
  args.cells.forEach((cell, docIndex) => {
    const attachedId = cell.selectedAudioId ?? cell.selectedGeneratedVoiceAudioId
    const attachment = attachedId ? cell.attachments?.[attachedId] : undefined
    if (!attachedId || !attachment?.url) {
      skipped.push({ cellId: cell.id, reason: "no audio" })
      return
    }
    const parsed = parseFrontierAudioUrl(attachment.url)
    if (!parsed) {
      skipped.push({ cellId: cell.id, reason: "unsupported audio URL (legacy clip)" })
      return
    }
    resolved.push({
      cell,
      docIndex,
      attachment,
      attachedId,
      audioId: parsed.audioId,
      ext: parsed.ext,
      clipKey: `${parsed.audioId}.${parsed.ext}`,
      voice: resolveCastVoice(args.settings, cell.id, cell.ttsSettings?.voiceId),
      trimmed: (attachment.trimStartMs ?? 0) > 0 || attachment.trimEndMs != null,
    })
  })

  const shareCount = new Map<string, number>()
  for (const c of resolved) shareCount.set(c.clipKey, (shareCount.get(c.clipKey) ?? 0) + 1)

  const total = resolved.length
  let done = 0
  const step = (): void => {
    done++
    args.onProgress?.(done, total)
  }
  const throwIfAborted = (): void => {
    if (args.signal?.aborted) {
      const reason: unknown = args.signal.reason
      throw reason ?? new DOMException("Aborted", "AbortError")
    }
  }

  // Lossless preference (mirrors audio-by-character): client-synth generated
  // voices keep the original WAV as an unattached sibling (same base id, ext
  // "wav") — exports always prefer it so the zip isn't a lossy transcode; any
  // failure falls back to the attached bytes.
  const fetchClipBytes = async (clip: ResolvedClip): Promise<{ bytes: Uint8Array; ext: string }> => {
    const generated = clip.attachedId === clip.cell.selectedGeneratedVoiceAudioId
    if (generated && clip.ext === "webm") {
      const wav = await args
        .fetchBytes({ projectId: args.projectId, fileId: clip.cell.fileId, audioId: clip.audioId, ext: "wav" })
        .catch(() => null)
      if (wav && wav.length > 0) return { bytes: wav, ext: "wav" }
    }
    const bytes = await args.fetchBytes({
      projectId: args.projectId,
      fileId: clip.cell.fileId,
      audioId: clip.audioId,
      ext: clip.ext,
    })
    return { bytes, ext: clip.ext }
  }

  // One fetch+decode per unique clip — a combined generation is attached to
  // every cell it covers under the same id. Failures stay cached too, so the
  // per-cell retries don't hammer the worker.
  const pcmByClip = new Map<string, Promise<Float32Array | null>>()
  const decodeClip = (clip: ResolvedClip): Promise<Float32Array | null> => {
    let promise = pcmByClip.get(clip.clipKey)
    if (!promise) {
      promise = fetchClipBytes(clip).then(({ bytes }) => (bytes.length > 0 ? args.decode(bytes) : null))
      pcmByClip.set(clip.clipKey, promise)
    }
    return promise
  }

  /** Decoded, trim-applied PCM for one cell's clip; null already recorded a skip. */
  const decodeTrimmed = async (clip: ResolvedClip): Promise<Float32Array | null> => {
    const pcm = await decodeClip(clip)
    if (!pcm) {
      skipped.push({ cellId: clip.cell.id, reason: "empty audio clip" })
      return null
    }
    return applyTrimPcm(pcm, TARGET_RATE, clip.attachment.trimStartMs, clip.attachment.trimEndMs)
  }

  const failReason = (err: unknown): string =>
    `audio failed: ${err instanceof Error ? err.message : String(err)}`

  // Entry-name dedupe — same _2/_3 convention as audio-by-character.
  const usedNames = new Map<string, number>()
  const claimName = (base: string, ext: string): string => {
    const seen = usedNames.get(base) ?? 0
    usedNames.set(base, seen + 1)
    return seen === 0 ? `${base}.${ext}` : `${base}_${seen + 1}.${ext}`
  }

  if (args.mode === "separate-clips") {
    for (const clip of resolved) {
      throwIfAborted()
      const base = `${String(clip.docIndex).padStart(3, "0")}_${characterKey(clip.cell.id)}_${characterKey(clip.voice.name)}`
      try {
        // Untrimmed clips unique to one cell pass through as stored — no
        // decode/re-encode. Trimmed or shared clips are sliced per cell
        // (combined-voice clips attach untrimmed to many cells; a naive copy
        // would emit the full multi-minute clip N times).
        if (!clip.trimmed && (shareCount.get(clip.clipKey) ?? 0) <= 1) {
          const { bytes, ext } = await fetchClipBytes(clip)
          if (bytes.length === 0) skipped.push({ cellId: clip.cell.id, reason: "empty audio clip" })
          else entries.push({ name: claimName(base, ext), data: new Blob([bytes as BlobPart], { type: audioMimeForExt(ext) }) })
        } else {
          const pcm = await decodeTrimmed(clip)
          if (pcm) entries.push({ name: claimName(base, "wav"), data: encodeWavPcm16(pcm, TARGET_RATE) })
        }
      } catch (err) {
        skipped.push({ cellId: clip.cell.id, reason: failReason(err) })
      }
      step()
    }
    return { entries, skipped }
  }

  if (args.mode === "file-clip") {
    const pcms: Float32Array[] = []
    for (const clip of resolved) {
      throwIfAborted()
      try {
        const pcm = await decodeTrimmed(clip)
        if (pcm) pcms.push(pcm)
      } catch (err) {
        skipped.push({ cellId: clip.cell.id, reason: failReason(err) })
      }
      step()
    }
    const all = concatPcm(pcms)
    if (all.length > 0) {
      entries.push({ name: claimName(`${args.fileSlug}_all`, "wav"), data: encodeWavPcm16(all, TARGET_RATE) })
    }
    return { entries, skipped }
  }

  // voice-clips / voice-timeline: decode everything in document order first,
  // keeping first-appearance voice order for stable entry ordering.
  const voiceOrder: string[] = []
  const voiceById = new Map<string, Voice>()
  const decoded: { clip: ResolvedClip; pcm: Float32Array }[] = []
  for (const clip of resolved) {
    throwIfAborted()
    try {
      const pcm = await decodeTrimmed(clip)
      if (pcm) {
        if (!voiceById.has(clip.voice.id)) {
          voiceById.set(clip.voice.id, clip.voice)
          voiceOrder.push(clip.voice.id)
        }
        decoded.push({ clip, pcm })
      }
    } catch (err) {
      skipped.push({ cellId: clip.cell.id, reason: failReason(err) })
    }
    step()
  }

  if (args.mode === "voice-clips") {
    for (const voiceId of voiceOrder) {
      const pcm = concatPcm(decoded.filter((d) => d.clip.voice.id === voiceId).map((d) => d.pcm))
      if (pcm.length === 0) continue // voice ended up with no decodable audio
      entries.push({
        name: claimName(characterKey(voiceById.get(voiceId)!.name), "wav"),
        data: encodeWavPcm16(pcm, TARGET_RATE),
      })
    }
    return { entries, skipped }
  }

  // voice-timeline: one shared timeline, one equal-length stem per voice.
  const timeline = buildTimeline(
    decoded.map((d) => ({ cellId: d.clip.cell.id, voiceId: d.clip.voice.id, pcm: d.pcm })),
  )
  if (timeline.totalSamples > 0) {
    for (const voiceId of voiceOrder) {
      entries.push({
        name: claimName(`${characterKey(voiceById.get(voiceId)!.name)}_timeline`, "wav"),
        data: encodeWavPcm16(writeTimelineTrack(timeline, voiceId), TARGET_RATE),
      })
    }
  }
  return { entries, skipped }
}
