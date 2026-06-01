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
    group.clips.push({ cellId: cell.id, audioId, url: attachment.url })
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
}

export async function exportAudioByCharacter(args: ExportAudioArgs): Promise<{ blob: Blob; skipped: number }> {
  const groups = groupAudioByCharacter(args.cells, args.settings)
  const zip = new JSZip()
  const usedNames = new Map<string, number>()
  const totalClips = groups.reduce((n, g) => n + g.clips.length, 0)
  let done = 0
  let skipped = 0

  for (const group of groups) {
    const pcmClips: Float32Array[] = []
    for (const clip of group.clips) {
      const cell = args.cells.find((c) => c.id === clip.cellId)!
      const parsed = parseFrontierAudioUrl(clip.url)
      if (!parsed) { done++; args.onProgress?.(done, totalClips); continue }
      try {
        const bytes = await args.fetchBytes({
          projectId: args.projectId, fileId: cell.fileId, audioId: parsed.audioId, ext: parsed.ext,
        })
        if (bytes.length > 0) pcmClips.push(await args.decode(bytes))
      } catch (err) {
        console.warn(`[audio-by-character] skipping clip ${clip.audioId} (${clip.cellId}):`, err)
        skipped++
      }
      done++
      args.onProgress?.(done, totalClips)
    }
    const pcm = concatPcm(pcmClips)
    if (pcm.length === 0) continue // character ended up with no decodable audio
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
