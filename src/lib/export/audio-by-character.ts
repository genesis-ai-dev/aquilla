// Client-side export: group cells by cast character, concatenate audio, encode WAV, zip.
// Pure functions (grouping, preview, concat) are unit-testable in happy-dom.
// The orchestrator (exportAudioByCharacter) takes an injected decode/fetch so
// tests can supply fakes; production wires real Web Audio + sync-worker fetch.

import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { resolveCastVoice } from "@/lib/audio/voices"

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
