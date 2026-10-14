// Per-cell Bible facts (AQU-1690): inputs and result shapes.
//
// The inputs are STRUCTURAL types, like ../bible-checks/types.ts: the few
// fields of the pack layers the facts read. The worker's pack types
// (auth-worker/src/lib/bkp/pack-types.ts) and the SPA's
// (src/lib/bible-data/pack-types.ts) both satisfy them.
//
// Relative imports only, no DOM: shared with the workers.

import type { SpeechInput, StructureLayerInput, VoicesLayerInput } from '../bible-checks/types'

export interface FactsSpeechInput extends SpeechInput {
  /** Entity id of who speaks, e.g. "person:Jesus.2". */
  speaker?: string
  addressee?: string
}

export interface FactsVoicesInput extends VoicesLayerInput {
  speeches: readonly FactsSpeechInput[]
}

export interface FactsStructureVerseInput {
  question: boolean
  imperative?: boolean
  numerals?: readonly string[]
  negators?: readonly string[]
}

export interface FactsStructureInput extends StructureLayerInput {
  verses: Readonly<Record<string, FactsStructureVerseInput>>
}

export interface FactsEntityInput {
  type: string
  gender?: string
  /** Label per language code; "eng" is the one the facts use. */
  labels: Readonly<Record<string, string>>
}

export interface FactsMentionInput {
  entity: string
  /** "explicit" (a name or noun), "pronoun", or "subject" (the subject a verb implies). */
  kind: string
  conf: number
}

export interface FactsPeopleInput {
  entities: Readonly<Record<string, FactsEntityInput>>
  /** Keyed by Macula word id. */
  mentions: Readonly<Record<string, FactsMentionInput>>
}

export interface FactsWordInput {
  class: string
  morph: string
  person?: string
  number?: string
}

export interface FactsTextInput {
  verses: Readonly<Record<string, readonly string[]>>
  words: Readonly<Record<string, FactsWordInput>>
}

/** The layers the facts read. Only voices is required; each missing layer leaves its facts out. */
export interface FactsLayers {
  voices: FactsVoicesInput
  structure: FactsStructureInput | null
  people: FactsPeopleInput | null
  /** Several MB per book, so it is often not loaded; then `secondPerson` is null. */
  text: FactsTextInput | null
}

// ── Results ─────────────────────────────────────────────────────────────────

export interface FactEntity {
  id: string
  /** The pack's English label, else the id. */
  label: string
  /** The project's agreed rendering of this name, when the caller found one. */
  rendering?: string
}

export interface SpeechFact {
  speechId: string
  speaker: FactEntity | null
  addressee: FactEntity | null
  /** Effective quote level: 0 means the target marks it with no quotation marks. */
  level: number
  depth: number
  selfProjected: boolean
  opens: boolean
  closes: boolean
  /** Neither opens nor closes here: the cell sits inside it. */
  continues: boolean
}

export type SecondPersonNumber = 'singular' | 'plural' | 'mixed'

export interface CellFacts {
  book: string
  refs: readonly string[]
  /** Speeches touching the cell, outermost first. */
  speeches: readonly SpeechFact[]
  /** People, groups and deities the cell names, in order of first mention. */
  participants: readonly FactEntity[]
  /** Subjects that verbs imply but the cell does not name. */
  impliedSubjects: readonly FactEntity[]
  /** Number of the Greek second-person forms; null when there are none or the text layer is not loaded. */
  secondPerson: SecondPersonNumber | null
  question: boolean
  /** Negators in the Greek (Macula), for the cell's verses. */
  negators: number
  numerals: number
  /**
   * Lower-level text follows a quotation that closes in this cell: the
   * narrator's aside in JHN 4:9 (endLevel 0), or the rest of Jesus' reply
   * after the request he quotes in JHN 4:10 (endLevel 1).
   */
  trailingText: { closeLevel: number; endLevel: number } | null
}
