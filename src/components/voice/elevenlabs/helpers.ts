// Pure helpers behind the ElevenLabs voice UI (AQU-2299), kept out of the
// component files so they stay fast-refresh friendly and unit-testable.
import { isVoiceChangedAudioId, originalTakeId } from "@/lib/audio/change-voice"
import { DEFAULT_ELEVENLABS_SETTINGS } from "@/lib/audio/elevenlabs/settings"
import type { CellData } from "@/hooks/useCells"
import type { ElevenLabsVoiceSettings } from "@/lib/parsers/types"
import type { ElevenLabsVoiceCategory, ElevenLabsVoiceRow } from "@/lib/sync/elevenlabs"

export const ELEVENLABS_CATEGORY_LABEL_KEYS = {
  premade: "audio.elevenLabs.categoryPremade",
  cloned: "audio.elevenLabs.categoryCloned",
  generated: "audio.elevenLabs.categoryDesigned",
  professional: "audio.elevenLabs.categoryProfessional",
} as const satisfies Record<ElevenLabsVoiceCategory, string>

/** Labels worth a chip, in the order they say most about a voice. */
const LABEL_ORDER = ["accent", "gender", "age", "language", "descriptive", "use_case", "use case"]

/** Up to two of a voice's labels, most telling first. */
export function voiceLabelChips(labels: Record<string, string>): string[] {
  const keys = [...LABEL_ORDER.filter((k) => labels[k]), ...Object.keys(labels).filter((k) => !LABEL_ORDER.includes(k))]
  return keys.slice(0, 2).map((k) => labels[k])
}

/** Client-side kind filter over the fetched page (search runs server-side). */
export function filterElevenLabsVoices(
  voices: readonly ElevenLabsVoiceRow[],
  category: ElevenLabsVoiceCategory | null,
): ElevenLabsVoiceRow[] {
  return category ? voices.filter((v) => v.category === category) : [...voices]
}

export function isDefaultElevenLabsSettings(s: ElevenLabsVoiceSettings): boolean {
  return (Object.keys(DEFAULT_ELEVENLABS_SETTINGS) as (keyof ElevenLabsVoiceSettings)[])
    .every((k) => s[k] === DEFAULT_ELEVENLABS_SETTINGS[k])
}

/**
 * Lines whose person's recording can be copied in as a cloning sample (first
 * 60). A clone should hear the speaker, so a Change voice result is walked back
 * to the recording it came from, and generated voices are never offered.
 */
export function linesWithTakes(cells: readonly CellData[]): { cell: CellData; audioId: string }[] {
  const out: { cell: CellData; audioId: string }[] = []
  for (const cell of cells) {
    if (!cell.selectedAudioId) continue
    const audioId = originalTakeId(cell.attachments, cell.selectedAudioId)
    const att = cell.attachments?.[audioId]
    if (att?.url && !att.isDeleted && att.role !== "source" && !isVoiceChangedAudioId(audioId)) out.push({ cell, audioId })
    if (out.length >= 60) break
  }
  return out
}

/** What a line is called in the take picker: the start of its text. */
export function lineSnippet(cell: Pick<CellData, "cellLabel" | "original" | "translated" | "id">): string {
  const raw = (cell.translated || cell.original || cell.cellLabel || "").trim()
  if (!raw) return cell.cellLabel || cell.id
  return raw.length > 56 ? `${raw.slice(0, 56)}…` : raw
}
