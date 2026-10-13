// Check pack B (AQU-1699): participants and cross-cell consistency.
//
// The inputs are STRUCTURAL types, like ./types.ts: the few fields of the
// pack's people layer (pack 1.1, bible-wiki pipeline/src/schemas/bkp.ts) and
// of the project's decisions and terminology that the checks read. The SPA's
// pack types, the worker's, and the pack JSON all satisfy them.
//
// Relative imports only, no DOM: shared with the workers.

import type { ProjectFact } from '../project-facts'
import type { BibleCheckSpan } from './types'

// ── People layer ────────────────────────────────────────────────────────────

/** One entity of `people/{BOOK}.json`. */
export interface PeopleEntityInput {
  /** person, group, deity, place, local-person, local-group, local-thing. */
  type: string
  /** Label per ISO 639-3 code ("eng", "spa"). */
  labels: Readonly<Record<string, string>>
  gender?: string
  /** The members of a group the pack minted ("Jews, Jesus"). */
  members?: readonly string[]
}

/** The word refers to `entity`. */
export interface PeopleMentionInput {
  entity: string
  /** "explicit" (a name or a noun), "pronoun", or "subject" (the subject a verb implies). */
  kind: string
  conf: number
}

export interface PeopleLayerInput {
  entities: Readonly<Record<string, PeopleEntityInput>>
  /** Keyed by Macula word id. */
  mentions: Readonly<Record<string, PeopleMentionInput>>
}

// ── Agreed names ────────────────────────────────────────────────────────────

/** A terminology entry, as the name lookup reads it. A `Concept` fits. */
export interface ConceptInput {
  id: string
  sourceTerm: string
  /** Only "active" entries count. */
  status: string
  renderings: readonly { rendering: string; status: string }[]
  /** AQU-1693 fills this: the ACAI entity the entry names, e.g. "person:Peter". */
  externalIds?: { acai?: string }
}

/** Where an agreed name comes from, in order of precedence. */
export type NameSource = 'fact' | 'terminology' | 'acai'

export interface AgreedName {
  entity: string
  /** Renderings that count as the name, the preferred one first. */
  renderings: readonly string[]
  /** Every rendering known for the name, accepted or not (P2's variants). */
  variants: readonly string[]
  source: NameSource
  /** The decision's key or the terminology entry's id. */
  from: string
}

/** An agreed name and, for a decision, where it applies. */
export interface ScopedName extends AgreedName {
  /** The decision behind it; absent for terminology, which applies everywhere. */
  fact?: ProjectFact
}

/** κύριος of Jesus, κύριος of God, and πνεῦμα of the Holy Spirit (P14). */
export type DivineNameKind = 'kyrios-jesus' | 'kyrios-god' | 'holy-spirit'

/** What a project has decided or entered that switches a pack-B check on. */
export interface BibleCheckReadiness {
  /** A name has an agreed rendering: a `render.<entity>` decision or a terminology entry. */
  agreedNames: boolean
  /** A name form has its own decision: `render.<entity>.form.<form>`. */
  nameForms: boolean
  /** `render.kyrios-jesus`, `render.kyrios-god` or `render.holy-spirit`. */
  divineNameFacts: boolean
  /** A `clusivity.*` decision. */
  clusivityFacts: boolean
  /** Target spans for pronouns: a word alignment the checks can read (P15). None exists yet. */
  pronounSpans: boolean
}

export const NO_READINESS: BibleCheckReadiness = {
  agreedNames: false,
  nameForms: false,
  divineNameFacts: false,
  clusivityFacts: false,
  pronounSpans: false,
}

/** One file's agreed names and decisions, built once and shared by its cells. */
export interface NameTable {
  /** Per entity: its decision first (when there is one), then terminology, then the ACAI hook. */
  names: ReadonlyMap<string, readonly ScopedName[]>
  /** Name-form decisions: entity → form key ("kephas") → its names. */
  forms: ReadonlyMap<string, ReadonlyMap<string, readonly ScopedName[]>>
  /** Entities that share a proper-noun lemma with this one: the six Marys, the nine Simons. */
  siblings: ReadonlyMap<string, readonly string[]>
  /** Decided renderings of κύριος and πνεῦμα. */
  divine: ReadonlyMap<DivineNameKind, ScopedName>
  /** `clusivity.*` decisions whose value is inclusive or exclusive. */
  clusivity: readonly ProjectFact[]
  /** The book's entities, for each finding's label and type. */
  entities: Readonly<Record<string, PeopleEntityInput>>
  readiness: BibleCheckReadiness
}

// ── One cell's participants ─────────────────────────────────────────────────

/** A name the cell's source uses: an explicit mention that is a proper noun. */
export interface NameMention {
  entity: string
  /** The Macula word. */
  word: string
  /** The lemma, which is the name form: Σίμων, Κηφᾶς, Πέτρος. */
  lemma: string
  /** The form's key in a name-form decision: the lemma in Latin letters ("kephas"). */
  form: string | null
}

export type Clusivity = 'inclusive' | 'exclusive'

/** A first-person-plural word ("we", or a verb that means it). */
export interface FirstPluralMention {
  word: string
  /** Who "we" are, per the pack; null when it has no mention. */
  entity: string | null
  /** From who "we" are and who is addressed; null when the data cannot tell. */
  clusivity: Clusivity | null
  /** The groups compared, for the evidence line. */
  referents: readonly string[]
  addressees: readonly string[]
}

/** A pronoun or verb whose referent is a group of a known size. */
export interface GroupMention {
  word: string
  entity: string
  size: number
}

export interface DivineMention {
  word: string
  kind: DivineNameKind
}

/** AQU-1701 (P11): a participant's first mention in its pericope, where the Greek uses a name. */
export interface ParticipantIntroduction {
  entity: string
  /** The Macula word of the name. */
  word: string
}

/** AQU-1701 (P13): a participant the cell refers to only as a verb's implied subject, with look-alikes beside it. */
export interface AmbiguousSubject {
  entity: string
  /** The verb whose subject it is. */
  word: string
  /** The verb's English gloss ("answered"), for the question. */
  gloss: string
  /** The cell's other active participants of the same gender and number. */
  peers: readonly string[]
}

export interface CellParticipants {
  names: NameTable
  /** The cell's names, in reading order. Empty without the text layer, which says which words are names. */
  named: readonly NameMention[]
  /** Every entity the cell's source mentions (explicit, pronoun or subject), and the members of each group among them. */
  mentioned: readonly string[]
  /** Implied subjects: subject mentions whose entity the cell does not mention explicitly, with the first verb. */
  impliedSubjects: readonly { entity: string; word: string }[]
  /** The subjects of the verses just before and just after the cell, with their groups' members. */
  nearbySubjects: readonly string[]
  /** The speakers and addressees of the speeches touching the cell. */
  voices: readonly string[]
  /**
   * Number of the Greek second-person forms; null when there are none or no
   * text layer. `explicit`: a pronoun, or a verb that is not an imperative.
   */
  secondPerson: { number: 'singular' | 'plural' | 'mixed'; explicit: boolean } | null
  firstPlural: readonly FirstPluralMention[]
  groups: readonly GroupMention[]
  divine: readonly DivineMention[]
  /** P15: target spans of the pronouns that refer to God, Jesus or the Spirit, from a word alignment. */
  deityPronounSpans?: readonly BibleCheckSpan[]
  /** AQU-1701 (P11): first mentions after a pericope boundary that are names. Empty without segments or the text layer. */
  introduced: readonly ParticipantIntroduction[]
  /** AQU-1701 (P13): implied subjects another active participant could be mistaken for. Empty without the text layer. */
  ambiguousSubjects: readonly AmbiguousSubject[]
}
