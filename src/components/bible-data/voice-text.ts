// Voices, words for pack ids (AQU-1687).
//
// The pack's enums reach the screen only through these typed tables, as the
// spec's vocabulary mapping requires (04-features/bible-knowledge-layer.md).
// An id the tables do not know is shown as the data spells it, never guessed.

import {
  BIBLE_DATA_SOURCE_NAME_KEYS,
  BIBLE_DATA_SOURCE_SHORT_NAME_KEYS,
} from "@/lib/bible-data/enrichment-labels"
import type { BkpVoicesLayer } from "@/lib/bible-data/pack-types"
import type { SpeechRailState } from "@/lib/bible-data/speech-rails"
import type { VoiceLabel, VoiceLabelSource } from "@/lib/bible-data/voice-labels"
import type { MessageKey } from "@/lib/i18n/messages/en"

/** Quote types (from the FCBH data), as the vocabulary table names them. */
export type SpeechType = "Dialogue" | "Normal" | "Quotation" | "Hypothetical" | "Implicit"

export const SPEECH_TYPE_KEYS: Readonly<Record<SpeechType, MessageKey>> = {
  Dialogue: "bibleData.voices.type.dialogue",
  Normal: "bibleData.voices.type.normal",
  Quotation: "bibleData.voices.type.quotation",
  Hypothetical: "bibleData.voices.type.hypothetical",
  Implicit: "bibleData.voices.type.implicit",
}

export function speechTypeKey(type: string | undefined): MessageKey | null {
  return type && Object.hasOwn(SPEECH_TYPE_KEYS, type) ? SPEECH_TYPE_KEYS[type as SpeechType] : null
}

/** The evidence the pack cites for a speaker or an addressee. */
export type EvidenceSource = "fcbh" | "macula" | "macula-1p" | "macula-2p" | "macula-a2"

export const EVIDENCE_SOURCE_KEYS: Readonly<Record<EvidenceSource, MessageKey>> = {
  // FCBH character ids reach the pack through Clear-Bible's speaker-quotations.
  fcbh: BIBLE_DATA_SOURCE_NAME_KEYS["speaker-quotations"],
  macula: BIBLE_DATA_SOURCE_SHORT_NAME_KEYS.macula,
  "macula-1p": "bibleData.voices.evidence.macula1p",
  "macula-2p": "bibleData.voices.evidence.macula2p",
  "macula-a2": "bibleData.voices.evidence.maculaA2",
}

export function evidenceSourceKey(source: string): MessageKey | null {
  return Object.hasOwn(EVIDENCE_SOURCE_KEYS, source) ? EVIDENCE_SOURCE_KEYS[source as EvidenceSource] : null
}

const LABEL_SOURCE_KEYS: Readonly<Record<VoiceLabelSource, MessageKey>> = {
  terminology: "bibleData.voices.labelSource.terminology",
  acai: "bibleData.voices.labelSource.acai",
  generated: "bibleData.voices.labelSource.generated",
  english: "bibleData.voices.labelSource.english",
}

/** "From your terminology", "From ACAI", … for where a name came from. */
export function labelSourceKey(label: VoiceLabel): MessageKey {
  if (label.source === "acai" && label.otherScript) return "bibleData.voices.labelSource.acaiOtherScript"
  return LABEL_SOURCE_KEYS[label.source]
}

export const RAIL_STATE_KEYS: Readonly<Record<SpeechRailState, MessageKey>> = {
  begins: "bibleData.voices.rail.begins",
  continues: "bibleData.voices.rail.continues",
  ends: "bibleData.voices.rail.ends",
  "begins-and-ends": "bibleData.voices.rail.beginsAndEnds",
}

/** "Narrator" in narrative books, "Author" in letters and Revelation. */
export function narratorKey(kind: BkpVoicesLayer["narrator"]["kind"]): MessageKey {
  return kind === "author" ? "bibleData.voices.author" : "bibleData.voices.narrator"
}
