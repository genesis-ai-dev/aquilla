/**
 * Audio assembly for org data egress — turns one file's cells into audio zip
 * entries for a chosen EgressAudioMode. Pure orchestration over injected
 * fetch/decode (Web Audio is browser-only; tests pass fakes), mirroring the
 * audio-by-character DI seam.
 *
 * Memory discipline (AQU-1862). An hour of audio is ~690 MB as 48 kHz Float32
 * and ~345 MB as the PCM16 that actually gets written, so no mode may hold a
 * whole file's audio — let alone a whole-file stem per voice — as typed arrays
 * on the heap. Three rules keep peak heap at roughly one clip:
 *
 *  1. A decoded clip is quantised to PCM16 and handed to blob storage as soon
 *     as it exists; the Float32 is released immediately.
 *  2. The fetch/decode dedupe cache is ref-counted against the number of cells
 *     sharing the clip, and drops the entry once the last one has had it.
 *  3. Concatenations and timeline stems are assembled as lists of blob parts
 *     (silence included, in reusable chunks), never as one big array.
 *
 * `peakPcmBytes` on the result reports what the run actually retained, so the
 * bound is asserted in tests and recordable in the browser (see memMark).
 */

import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import type { EgressAudioMode } from "@/lib/egress/types"
import { resolveCastVoice } from "@/lib/audio/voices"
import { parseFrontierAudioUrl } from "@/lib/audio/upload"
import { encodeWavPcm16Blobs, toPcm16, WAV_HEADER_BYTES } from "@/lib/audio/wav-encode"
import { TARGET_RATE } from "@/lib/audio/decode-mono"
import { audioMimeForExt } from "@/lib/audio/mime"
import { characterKey } from "@/lib/export/audio-by-character"

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
  /** Peak decoded-audio bytes this run retained on the JS heap (AQU-1862).
   *  Bounded by the clips in flight, never by the file's total length — the
   *  memory-bound tests assert that, and build-project-export marks it so a
   *  QA run can record the number. */
  peakPcmBytes: number
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

/** Silence is emitted in chunks of this many PCM16 samples (~5.5 s at 48 kHz,
 *  512 KiB) from ONE reusable buffer. A stem is mostly silence — the other
 *  voices' spans — and zero-filling it in one allocation is exactly the
 *  full-length array this mode used to crash on. */
export const SILENCE_CHUNK_SAMPLES = 1 << 18

export interface TimelineClip {
  cellId: string
  voiceId: string
  /** Post-trim PCM16 bytes at TARGET_RATE, already in blob storage. */
  data: Blob
  /** Sample count — `data.size / 2`, carried so offset maths needs no reads. */
  samples: number
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
export function buildTimeline(clips: readonly TimelineClip[]): Timeline {
  const placements: TimelinePlacement[] = []
  let offset = 0
  for (const clip of clips) {
    placements.push({ ...clip, offset })
    offset += clip.samples
  }
  return { totalSamples: offset, placements }
}

/** Append `samples` worth of silence to `parts`, in SILENCE_CHUNK_SAMPLES
 *  slices cut from one buffer (the Blob constructor copies, so reuse is safe). */
function pushSilence(parts: Blob[], samples: number): void {
  if (samples <= 0) return
  const zeros = new Int16Array(Math.min(samples, SILENCE_CHUNK_SAMPLES))
  let left = samples
  while (left > 0) {
    const n = Math.min(left, zeros.length)
    parts.push(new Blob([n === zeros.length ? zeros : zeros.subarray(0, n)]))
    left -= n
  }
}

/**
 * One voice's stem as PCM16 blob parts: its clips at their offsets, zero-filled
 * silence while other voices speak. The parts total `totalSamples` samples for
 * every voice — identical length across voices is what makes the tracks
 * droppable as a set — while the heap only ever holds one silence chunk.
 */
export function writeTimelineTrackParts(timeline: Timeline, voiceId: string): Blob[] {
  const parts: Blob[] = []
  let written = 0
  for (const p of timeline.placements) {
    if (p.voiceId !== voiceId || p.samples === 0) continue
    pushSilence(parts, p.offset - written)
    parts.push(p.data)
    written = p.offset + p.samples
  }
  // Padded even when the voice placed nothing: a stem is totalSamples long for
  // every voice on the timeline, silence included.
  pushSilence(parts, timeline.totalSamples - written)
  return parts
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

  // Retained decoded-audio accounting (AQU-1862). Every decoded array this run
  // is still holding is counted here, so the bound is a number the tests and a
  // QA walk can read rather than a claim in a comment.
  let livePcmBytes = 0
  let peakPcmBytes = 0
  const retain = (bytes: number): void => {
    livePcmBytes += bytes
    if (livePcmBytes > peakPcmBytes) peakPcmBytes = livePcmBytes
  }
  const release = (bytes: number): void => {
    livePcmBytes -= bytes
  }

  // One fetch+decode per unique clip — a combined generation is attached to
  // every cell it covers under the same id. Failures stay cached too, so the
  // per-cell retries don't hammer the worker.
  //
  // The cache is ref-counted against the cells sharing the clip and dropped
  // after the last of them: a clip held until the end of the file would mean
  // the whole file's audio resident at once, which is the crash in AQU-1862.
  interface CachedClip {
    pcm: Promise<Float32Array | null>
    remaining: number
  }
  const pcmByClip = new Map<string, CachedClip>()
  const decodeClip = (clip: ResolvedClip): Promise<Float32Array | null> => {
    let cached = pcmByClip.get(clip.clipKey)
    if (!cached) {
      cached = {
        pcm: fetchClipBytes(clip)
          .then(({ bytes }) => (bytes.length > 0 ? args.decode(bytes) : null))
          .then((pcm) => {
            if (pcm) retain(pcm.length * 4)
            return pcm
          }),
        remaining: shareCount.get(clip.clipKey) ?? 1,
      }
      pcmByClip.set(clip.clipKey, cached)
    }
    return cached.pcm
  }
  /** Last consumer of a clip drops it, so the decoded array can be collected.
   *  Failed decodes stay cached (and cost nothing) until then. */
  const consumed = (clip: ResolvedClip, pcm: Float32Array | null): void => {
    const cached = pcmByClip.get(clip.clipKey)
    if (!cached) return
    cached.remaining--
    if (cached.remaining > 0) return
    pcmByClip.delete(clip.clipKey)
    if (pcm) release(pcm.length * 4)
  }

  /** One cell's post-trim audio as PCM16 in blob storage, with the decoded
   *  Float32 released on the way out; null already recorded a skip. */
  const pcm16PartFor = async (clip: ResolvedClip): Promise<{ data: Blob; samples: number } | null> => {
    const pcm = await decodeClip(clip)
    if (!pcm) {
      skipped.push({ cellId: clip.cell.id, reason: "empty audio clip" })
      consumed(clip, pcm)
      return null
    }
    const trimmed = applyTrimPcm(pcm, TARGET_RATE, clip.attachment.trimStartMs, clip.attachment.trimEndMs)
    // Quantise, hand the bytes to blob storage, drop both arrays: from here on
    // the clip costs the heap nothing, whatever the mode does with it.
    const quantised = toPcm16(trimmed)
    retain(quantised.byteLength)
    const data = new Blob([quantised])
    release(quantised.byteLength)
    consumed(clip, pcm)
    return { data, samples: quantised.length }
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
  /** Finish one WAV entry from PCM16 parts already in blob storage. */
  const wav = (parts: readonly Blob[]): Blob => encodeWavPcm16Blobs(parts, TARGET_RATE)

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
          const part = await pcm16PartFor(clip)
          if (part) entries.push({ name: claimName(base, "wav"), data: wav([part.data]) })
        }
      } catch (err) {
        skipped.push({ cellId: clip.cell.id, reason: failReason(err) })
      }
      step()
    }
    return { entries, skipped, peakPcmBytes }
  }

  if (args.mode === "file-clip") {
    // Parts, not one growing array: the concatenation of a whole file's audio
    // exists in blob storage and never as a Float32Array (AQU-1862).
    const parts: Blob[] = []
    for (const clip of resolved) {
      throwIfAborted()
      try {
        const part = await pcm16PartFor(clip)
        if (part) parts.push(part.data)
      } catch (err) {
        skipped.push({ cellId: clip.cell.id, reason: failReason(err) })
      }
      step()
    }
    const blob = wav(parts)
    if (blob.size > WAV_HEADER_BYTES) {
      entries.push({ name: claimName(`${args.fileSlug}_all`, "wav"), data: blob })
    }
    return { entries, skipped, peakPcmBytes }
  }

  // voice-clips / voice-timeline: walk every clip in document order first,
  // keeping first-appearance voice order for stable entry ordering. Each clip
  // is in blob storage by the time the next one is fetched.
  const voiceOrder: string[] = []
  const voiceById = new Map<string, Voice>()
  const placed: TimelineClip[] = []
  for (const clip of resolved) {
    throwIfAborted()
    try {
      const part = await pcm16PartFor(clip)
      if (part) {
        if (!voiceById.has(clip.voice.id)) {
          voiceById.set(clip.voice.id, clip.voice)
          voiceOrder.push(clip.voice.id)
        }
        placed.push({ cellId: clip.cell.id, voiceId: clip.voice.id, data: part.data, samples: part.samples })
      }
    } catch (err) {
      skipped.push({ cellId: clip.cell.id, reason: failReason(err) })
    }
    step()
  }

  if (args.mode === "voice-clips") {
    for (const voiceId of voiceOrder) {
      const parts = placed.filter((c) => c.voiceId === voiceId).map((c) => c.data)
      const blob = wav(parts)
      if (blob.size === WAV_HEADER_BYTES) continue // voice ended up with no decodable audio
      entries.push({ name: claimName(characterKey(voiceById.get(voiceId)!.name), "wav"), data: blob })
    }
    return { entries, skipped, peakPcmBytes }
  }

  // voice-timeline: one shared timeline, one equal-length stem per voice.
  const timeline = buildTimeline(placed)
  if (timeline.totalSamples > 0) {
    for (const voiceId of voiceOrder) {
      entries.push({
        name: claimName(`${characterKey(voiceById.get(voiceId)!.name)}_timeline`, "wav"),
        data: wav(writeTimelineTrackParts(timeline, voiceId)),
      })
    }
  }
  return { entries, skipped, peakPcmBytes }
}
