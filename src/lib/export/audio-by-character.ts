// Client-side export: group cells by cast character, concatenate audio, encode WAV, zip.
// Pure functions (grouping, preview, concat) are unit-testable in happy-dom.
// The orchestrator (exportAudioByCharacter) takes an injected decode/fetch so
// tests can supply fakes; production wires real Web Audio + sync-worker fetch.

import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { resolveCastVoice } from "@/lib/audio/voices"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"
import { parseFrontierAudioUrl } from "@/lib/audio/upload"
import { TARGET_RATE } from "@/lib/audio/decode-mono"

export interface CharacterClip {
  cellId: string
  audioId: string
  /** frontier-audio:// URL on the chosen attachment. */
  url: string
  /** Cell timecode in seconds; null for untimed (non-timeline) files. */
  startSec: number | null
}

export interface CharacterGroup {
  voice: Voice
  clips: CharacterClip[]
}

export interface CharacterPreview {
  voiceId: string
  name: string
  color?: string
  clipCount: number
  /** Sum of known attachment durations; null when any clip lacks durationMs. */
  totalDurationMs: number | null
}

/** Pick the best-available audio for a cell: recording slot first, else
 *  generated-voice slot. Returns null when the cell has no usable audio. */
function bestAudioId(cell: CellData): string | null {
  return cell.selectedAudioId ?? cell.selectedGeneratedVoiceAudioId ?? null
}

export function groupAudioByCharacter(
  cells: CellData[],
  settings: ProjectTtsSettings | undefined,
): CharacterGroup[] {
  const order: string[] = []
  const byVoice = new Map<string, CharacterGroup>()

  for (const cell of cells) {
    const audioId = bestAudioId(cell)
    if (!audioId) continue
    const attachment = cell.attachments?.[audioId]
    if (!attachment?.url) continue
    const voice = resolveCastVoice(settings, cell.id, cell.ttsSettings?.voiceId)
    let group = byVoice.get(voice.id)
    if (!group) {
      group = { voice, clips: [] }
      byVoice.set(voice.id, group)
      order.push(voice.id)
    }
    group.clips.push({
      cellId: cell.id,
      audioId,
      url: attachment.url,
      startSec: typeof cell.startTime === "number" ? cell.startTime : null,
    })
  }
  return order.map((id) => byVoice.get(id)!)
}

export function previewAudioByCharacter(
  cells: CellData[],
  settings: ProjectTtsSettings | undefined,
): CharacterPreview[] {
  return groupAudioByCharacter(cells, settings).map((g) => {
    let total: number | null = 0
    for (const clip of g.clips) {
      const dur = findCell(cells, clip.cellId)?.attachments?.[clip.audioId]?.durationMs
      if (dur == null || total == null) total = null
      else total += dur
    }
    return {
      voiceId: g.voice.id,
      name: g.voice.name,
      color: g.voice.color,
      clipCount: g.clips.length,
      totalDurationMs: total,
    }
  })
}

function findCell(cells: CellData[], id: string): CellData | undefined {
  return cells.find((c) => c.id === id)
}

/** Concatenate mono PCM clips (all assumed at the same sample rate) into one
 *  Float32Array. Document-order back-to-back; no silence, no timeline. */
export function concatPcm(clips: Float32Array[]): Float32Array {
  let total = 0
  for (const c of clips) total += c.length
  const out = new Float32Array(total)
  let offset = 0
  for (const c of clips) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

// ─── Timeline layout (AQU-905) ───────────────────────────────────────────────

/**
 * How a character's clips are laid out in their exported track.
 *
 * - `concat` — back-to-back in document order, no silence (the original
 *   behavior; correct for untimed files like scripture).
 * - `timeline` — each clip at its own timecode inside a full-length track,
 *   silence in the gaps. Every character's track is the same length (the
 *   episode), so the set can be aligned/mixed in an external DAW.
 */
export type AudioTrackLayout = "concat" | "timeline"

export interface TimelinePcmClip {
  pcm: Float32Array
  /** Timeline offset in seconds; null when the cell carries no timecode. */
  startSec: number | null
}

/**
 * Lay mono PCM clips out on one full-length timeline track: each clip starts at
 * its own timecode, the gaps are silence, and the track runs for at least
 * `episodeSec` so every character's track comes out the same length.
 *
 * Untimed clips are appended after the furthest-written sample rather than
 * dropped, so a partially-timed file still exports all of its audio. Overlaps
 * are summed and clamped to [-1, 1].
 */
export function placePcmOnTimeline(
  clips: TimelinePcmClip[],
  sampleRate: number,
  episodeSec = 0,
): Float32Array {
  const placed: { pcm: Float32Array; offset: number }[] = []
  let end = 0
  for (const clip of clips) {
    const offset =
      clip.startSec != null && Number.isFinite(clip.startSec)
        ? Math.max(0, Math.round(clip.startSec * sampleRate))
        : end
    placed.push({ pcm: clip.pcm, offset })
    end = Math.max(end, offset + clip.pcm.length)
  }
  const total = Math.max(end, Math.round(Math.max(0, episodeSec) * sampleRate))
  const out = new Float32Array(total)
  for (const { pcm, offset } of placed) {
    for (let i = 0; i < pcm.length; i++) {
      const sum = out[offset + i] + pcm[i]
      out[offset + i] = sum > 1 ? 1 : sum < -1 ? -1 : sum
    }
  }
  return out
}

/** True when any cell carries a timecode — i.e. the file is timeline-ordered
 *  (media/subtitle) and per-voice tracks should be timeline-placed. */
export function hasTimecodes(cells: CellData[]): boolean {
  return cells.some((c) => typeof c.startTime === "number" || typeof c.endTime === "number")
}

/** Full episode length in seconds: the furthest timecode across ALL cells (not
 *  just one character's), so every exported track is the same length. */
export function episodeDurationSec(cells: CellData[]): number {
  let max = 0
  for (const cell of cells) {
    if (typeof cell.endTime === "number" && cell.endTime > max) max = cell.endTime
    if (typeof cell.startTime === "number" && cell.startTime > max) max = cell.startTime
  }
  return max
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/** Filesystem-safe character key (mirrors codex-editor's sanitization). */
export function characterKey(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed"
}

export interface ExportAudioArgs {
  cells: CellData[]
  settings: ProjectTtsSettings | undefined
  projectId: string
  langCode: string
  /** Fetch raw bytes for one clip. Production passes a closure over
   *  fetchCellAudio + the file's sync token. */
  fetchBytes: (args: { projectId: string; fileId: string; audioId: string; ext: string }) => Promise<Uint8Array>
  /** Decode bytes → mono PCM at TARGET_RATE. Production passes decodeToMono48k;
   *  tests pass a fake. */
  decode: (bytes: Uint8Array) => Promise<Float32Array>
  onProgress?: (done: number, total: number) => void
  /** AQU-905: `timeline` lays each character's clips out at their own timecodes
   *  inside a full-length track (silence in the gaps) so the set can be aligned
   *  in an external tool. Defaults to `timeline` when the cells carry timecodes
   *  and `concat` when they don't. */
  layout?: AudioTrackLayout
  /** Explicit episode length in seconds (e.g. the linked video's duration).
   *  Defaults to the furthest timecode across `cells`. `timeline` layout only. */
  episodeSec?: number
}

export async function exportAudioByCharacter(args: ExportAudioArgs): Promise<{ blob: Blob; skipped: number }> {
  const groups = groupAudioByCharacter(args.cells, args.settings)
  const layout: AudioTrackLayout = args.layout ?? (hasTimecodes(args.cells) ? "timeline" : "concat")
  const episodeSec = args.episodeSec ?? episodeDurationSec(args.cells)
  const zip = new JSZip()
  const usedNames = new Map<string, number>()
  const totalClips = groups.reduce((n, g) => n + g.clips.length, 0)
  let done = 0
  let skipped = 0

  // A COMBINED generation is attached to every cell it covers under the same
  // base id — fetch and decode each unique clip ONCE, not once per cell (with
  // the WAV preference below that difference is a dozen multi-minute
  // downloads). A failure stays cached too, so retries per cell don't hammer.
  const pcmByClip = new Map<string, Promise<Float32Array | null>>()

  for (const group of groups) {
    const pcmClips: TimelinePcmClip[] = []
    for (const clip of group.clips) {
      const cell = args.cells.find((c) => c.id === clip.cellId)!
      const parsed = parseFrontierAudioUrl(clip.url)
      if (!parsed) { done++; args.onProgress?.(done, totalClips); continue }
      const clipKey = `${parsed.audioId}.${parsed.ext}`
      let pcmPromise = pcmByClip.get(clipKey)
      if (!pcmPromise) {
        pcmPromise = (async () => {
          // Lossless preference (meeting 2026-08-05): client-synth generated
          // voices keep the original WAV as an unattached sibling (same base
          // id, ext "wav") — exports ALWAYS prefer it, regardless of the
          // device playback pref, so the zip isn't a lossy transcode. Any
          // failure falls back to the attached bytes.
          const generated = clip.audioId === cell.selectedGeneratedVoiceAudioId
          let bytes: Uint8Array | null = null
          if (generated && parsed.ext === "webm") {
            bytes = await args
              .fetchBytes({ projectId: args.projectId, fileId: cell.fileId, audioId: parsed.audioId, ext: "wav" })
              .catch(() => null)
          }
          if (bytes == null || bytes.length === 0) {
            bytes = await args.fetchBytes({
              projectId: args.projectId, fileId: cell.fileId, audioId: parsed.audioId, ext: parsed.ext,
            })
          }
          return bytes.length > 0 ? await args.decode(bytes) : null
        })()
        pcmByClip.set(clipKey, pcmPromise)
      }
      try {
        const pcm = await pcmPromise
        if (pcm) pcmClips.push({ pcm, startSec: clip.startSec })
      } catch (err) {
        console.warn(`[audio-by-character] skipping clip ${clip.audioId} (${clip.cellId}):`, err)
        skipped++
      }
      done++
      args.onProgress?.(done, totalClips)
    }
    // A character with no decodable audio is dropped entirely — even in
    // timeline layout, where an all-silence full-length track would just be
    // dead weight in the zip.
    const usable = pcmClips.filter((c) => c.pcm.length > 0)
    if (usable.length === 0) continue
    const pcm =
      layout === "timeline"
        ? placePcmOnTimeline(usable, TARGET_RATE, episodeSec)
        : concatPcm(usable.map((c) => c.pcm))
    if (pcm.length === 0) continue
    const wav = encodeWavPcm16(pcm, TARGET_RATE)
    // Disambiguate same-named cast members.
    const base = `${characterKey(group.voice.name)}_${args.langCode}`
    const seen = usedNames.get(base) ?? 0
    usedNames.set(base, seen + 1)
    const name = seen === 0 ? `${base}.wav` : `${base}_${seen + 1}.wav`
    zip.file(name, wav)
  }

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" })
  return { blob, skipped }
}
