// Voices, the project's corrections (AQU-1692).
//
// A maintainer corrects who speaks a pack speech, or to whom
// (`bibleVoiceOverrides`, db/shared/bible-voice-overrides.ts). The voice index
// is built from the corrected speeches, so the chip, the rails and "Show every
// line by …" all follow the correction. The pack's own reading is kept beside
// each correction, so the popover can say what it replaced. Pure: no React,
// no i18n, no network.

import type { BibleVoiceOverride, BibleVoiceOverrides } from "../../../db/shared/bible-voice-overrides"
import type { BkpEntityId, BkpSpeech, BkpVoicesLayer } from "./pack-types"

/** A correction as the index holds it. */
export interface AppliedVoiceOverride {
  override: BibleVoiceOverride
  /** The pack's reading before the correction. */
  original: { speaker?: BkpEntityId; addressee?: BkpEntityId }
}

export interface CorrectedVoices {
  layer: BkpVoicesLayer
  /** By speech id. */
  applied: ReadonlyMap<string, AppliedVoiceOverride>
  /** This book's corrections whose speech the pack no longer has: a rebuilt pack moved its boundary. */
  orphaned: readonly string[]
}

/** The evidence a corrected speaker or addressee cites. */
export const PROJECT_SOURCE = "project"

const NONE: ReadonlyMap<string, AppliedVoiceOverride> = new Map()

/**
 * The book's word-id prefix ("n43" for John, "o08" for Ruth). A speech id is
 * "sp:" + its first word id, so it says which book the speech is in.
 */
function bookPrefix(layer: BkpVoicesLayer): string | null {
  for (const units of Object.values(layer.verses)) {
    if (units[0]) return units[0].from.slice(0, 3)
  }
  return null
}

/** The corrections that belong to this book, sorted by speech id. */
function bookOverrides(layer: BkpVoicesLayer, overrides: BibleVoiceOverrides): [string, BibleVoiceOverride][] {
  const prefix = bookPrefix(layer)
  if (!prefix) return []
  return Object.entries(overrides)
    .filter(([id]) => id.startsWith(`sp:${prefix}`))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * A short, stable key for this book's corrections: equal corrections give an
 * equal key whatever object they arrive in, and "" means none. The index memo
 * uses it, so a settings refetch does not rebuild the index (and re-render
 * every row), while a changed correction does.
 */
export function voiceOverridesKey(layer: BkpVoicesLayer, overrides: BibleVoiceOverrides | undefined): string {
  const mine = overrides ? bookOverrides(layer, overrides) : []
  if (mine.length === 0) return ""
  // FNV-1a, 32-bit.
  const text = JSON.stringify(mine)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${mine.length}.${(hash >>> 0).toString(36)}`
}

/** The layer with this book's corrections applied. The layer itself is never changed. */
export function applyVoiceOverrides(layer: BkpVoicesLayer, overrides: BibleVoiceOverrides | undefined): CorrectedVoices {
  const mine = new Map(overrides ? bookOverrides(layer, overrides) : [])
  if (mine.size === 0) return { layer, applied: NONE, orphaned: [] }
  const applied = new Map<string, AppliedVoiceOverride>()
  const speeches = layer.speeches.map((speech): BkpSpeech => {
    const override = mine.get(speech.id)
    if (!override) return speech
    applied.set(speech.id, { override, original: { speaker: speech.speaker, addressee: speech.addressee } })
    const next: BkpSpeech = { ...speech }
    if (override.speaker) {
      next.speaker = override.speaker
      next.speakerConf = 1
      next.speakerSources = [PROJECT_SOURCE]
    }
    if (override.addressee) {
      next.addressee = override.addressee
      next.addresseeConf = 1
      next.addresseeSources = [PROJECT_SOURCE]
    }
    return next
  })
  const orphaned = [...mine.keys()].filter((id) => !applied.has(id))
  return { layer: { ...layer, speeches }, applied, orphaned }
}
