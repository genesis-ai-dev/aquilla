// Bible Knowledge Pack (BKP) v1, as the SPA reads it (AQU-1686).
//
// The contract is owned by the pipeline that builds and publishes the pack:
// bible-wiki pipeline/src/schemas/bkp.ts (zod schemas, checked at build time
// before anything is published). These types mirror it; keep them in step.
// AQU-1695: pack 1.1.0 (`notes`, `terms`, and `via`, `descriptions`, `kin`
// and `local-thing` in `people`), plus the two optional fields pack slice 3
// will add (a deity mention's `form`, a speech's `disputed`).
//
// The SPA checks each file's envelope only: the right kind of object, for the
// right book, with the top-level fields its layer needs. That is enough to
// turn a wrong file, an HTML error page or a truncated download into
// `invalid` before any renderer sees it, without re-running the pipeline's
// field-by-field checks on several MB per book. So readers check each item
// they use, skip one that is malformed, and ignore fields they do not know:
// a newer pack may add some.

import type { BkpLayer } from "../../../db/shared/bible-enrichments"

/** Macula SBLGNT word id: "n" + book(2) + chapter(3) + verse(3) + word(3), e.g. "n43004007012". */
export type BkpWordId = string
/** USFM book code + chapter:verse in ORG versification, e.g. "JHN 4:7". */
export type BkpRef = string
/** An ACAI id ("person:Jesus.2") or a local or group id minted by the pack. */
export type BkpEntityId = string

export interface BkpWord {
  text: string
  after: string
  lemma: string
  gloss: string
  english?: string
  class: string
  type?: string
  morph: string
  person?: string
  number?: string
  gender?: string
  case?: string
  mood?: string
  tense?: string
  voice?: string
  strong?: string
}

export interface BkpTextLayer {
  book: string
  verses: Record<BkpRef, BkpWordId[]>
  words: Record<BkpWordId, BkpWord>
}

export type BkpMoveFinal = "period" | "raised-dot" | "comma" | "question" | "none"

export interface BkpStructureVerse {
  question: boolean
  imperative: boolean
  numerals: BkpWordId[]
  negators: BkpWordId[]
  vocatives: BkpWordId[]
}

export interface BkpStructureLayer {
  book: string
  segments: { id: string; from: BkpWordId; to: BkpWordId; title: string }[]
  moves: { from: BkpWordId; to: BkpWordId; final: BkpMoveFinal }[]
  verses: Record<BkpRef, BkpStructureVerse>
}

export interface BkpSpeech {
  /** "sp:{firstWordId}-{lastWordId}". */
  id: string
  from: BkpWordId
  to: BkpWordId
  depth: number
  level: number
  parent: string | null
  selfProjected: boolean
  projector?: BkpWordId
  speaker?: BkpEntityId
  speakerConf: number
  speakerSources: string[]
  addressee?: BkpEntityId
  addresseeConf?: number
  addresseeSources?: string[]
  type?: string
  delivery?: string
  fcbh?: string
  /** Pack slice 3 (not built yet): scholars disagree where this speech starts or ends. */
  disputed?: BkpSpeechDispute
}

/** Why a speech's boundary is disputed, and who says so. Data, in English. */
export interface BkpSpeechDispute {
  reason: string
  source: string
}

export interface BkpVoiceUnit {
  speech: string
  from: BkpWordId
  to: BkpWordId
  opens: boolean
  closes: boolean
}

export interface BkpVoicesLayer {
  book: string
  narrator: { kind: "narrator" | "author"; entity?: BkpEntityId }
  speeches: BkpSpeech[]
  verses: Record<BkpRef, BkpVoiceUnit[]>
}

/** Pack 1.1 adds `local-thing`: an unnamed thing ("water"), never a participant. */
export type BkpEntityType = "person" | "group" | "deity" | "place" | "local-person" | "local-group" | "local-thing"

/** ACAI's family relations (pack 1.1), limited to entities in the same book's entity map. */
export interface BkpKin {
  father?: BkpEntityId[]
  mother?: BkpEntityId[]
  siblings?: BkpEntityId[]
  partners?: BkpEntityId[]
  offspring?: BkpEntityId[]
}

export interface BkpEntity {
  type: BkpEntityType
  acai?: string
  gender?: string
  genderSource?: "acai" | "grammatical"
  /** Label per language code. */
  labels: Record<string, string>
  labelSource: "acai" | "fcbh" | "gloss"
  /** Pack 1.1: ACAI's first description per language code (in practice English), plain text, about 200 characters. */
  descriptions?: Record<string, string>
  /** Pack 1.1. */
  kin?: BkpKin
  members?: BkpEntityId[]
  anchor?: BkpWordId
  mergedFrom?: BkpWordId[]
}

export interface BkpMention {
  entity: BkpEntityId
  kind: "explicit" | "pronoun" | "subject"
  /** `macula+voices` (pack 1.1): a vocative, or a chain through one, names its speech's addressee. */
  src: "acai" | "macula" | "acai+macula" | "macula+voices"
  hops: number
  /** Pack 1.1: the Macula words the chain went through, in order (hops − 1 of them; only when hops ≥ 2). */
  via?: BkpWordId[]
  conf: number
  /**
   * Pack slice 3 (not built yet): how the text names a deity at this word,
   * per language code, at least `eng`: θεός → "God", where the entity's own
   * label is "LORD".
   */
  form?: Record<string, string>
}

export interface BkpPeopleLayer {
  book: string
  entities: Record<BkpEntityId, BkpEntity>
  mentions: Record<BkpWordId, BkpMention>
}

/**
 * Where a note's quote was found in the verse's Macula words (pack 1.1):
 *   anchored   — in one place: `words` are those words;
 *   ambiguous  — in several places: `words` is the shortest, so no highlight;
 *   unanchored — nowhere (a different spelling or word order): `words` is empty.
 * A note with no quote (General Information) has no `anchor` and no words.
 */
export type BkpNoteAnchor = "anchored" | "ambiguous" | "unanchored"

/** One unfoldingWord Translation Note. Its text is English. */
export interface BkpNote {
  /** "tn:{content id}". */
  id: string
  ref: BkpRef
  /** The last verse of a note on a range of verses. */
  endRef?: BkpRef
  /** The Greek the note discusses (UGNT spelling). */
  quote?: string
  /** The unfoldingWord Translation Academy slug ("figs-rquestion"), or "other". */
  category?: string
  /** The pipeline always writes it; a reader treats a missing one as empty. */
  words?: BkpWordId[]
  anchor?: BkpNoteAnchor
  /** Plain text, cut after about 400 characters. */
  text: string
  altTranslations?: string[]
}

/** One unfoldingWord Translation Question. Its text is English. */
export interface BkpQuestion {
  /** "tq:{content id}". */
  id: string
  /** Every verse it covers: a range is expanded ("JHN 4:14", "JHN 4:15"). */
  refs: BkpRef[]
  q: string
  a: string
}

export interface BkpNotesLayer {
  book: string
  notes: BkpNote[]
  questions: BkpQuestion[]
}

/** "tw:{article}" for a Translation Words article, or an ACAI keyterm id ("keyterm:Life.2"). */
export type BkpTermId = string

export interface BkpTerm {
  /** English title. */
  title: string
  source: "tw" | "acai"
  /** Strong's numbers ("4540"); empty for ACAI keyterms. */
  strongs: string[]
  /** Localized titles per language code, when the source has them. */
  titles?: Record<string, string>
}

export interface BkpTermsLayer {
  book: string
  /** The words that carry at least one term. */
  words: Record<BkpWordId, BkpTermId[]>
  terms: Record<BkpTermId, BkpTerm>
}

/** What each layer's file holds. */
export interface BkpLayerData {
  text: BkpTextLayer
  structure: BkpStructureLayer
  voices: BkpVoicesLayer
  people: BkpPeopleLayer
  notes: BkpNotesLayer
  terms: BkpTermsLayer
}

export interface BkpManifest {
  pack: "bkp"
  version: string
  builtAt: string
  versification: "org"
  sources: { id: string; repo: string; commit: string; path?: string; sha256?: string }[]
  layers: Record<string, { license: string; attribution: { source: string; license: string; url: string }[] }>
  books: Record<string, { layers: string[]; bytes: Record<string, number> }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A manifest, or null when `raw` is not one. Every book entry is checked: the loader reads them. */
export function parseManifest(raw: unknown): BkpManifest | null {
  if (!isRecord(raw)) return null
  if (raw.pack !== "bkp" || raw.versification !== "org") return null
  if (typeof raw.version !== "string" || raw.version === "" || typeof raw.builtAt !== "string") return null
  if (!Array.isArray(raw.sources) || !isRecord(raw.layers) || !isRecord(raw.books)) return null
  for (const entry of Object.values(raw.books)) {
    if (!isRecord(entry) || !isRecord(entry.bytes) || !Array.isArray(entry.layers)) return null
    if (!entry.layers.every((layer) => typeof layer === "string")) return null
  }
  return raw as unknown as BkpManifest
}

/** The top-level fields each layer must carry, by container type. */
const LAYER_SHAPES: Readonly<Record<BkpLayer, { objects: readonly string[]; arrays: readonly string[] }>> = {
  text: { objects: ["verses", "words"], arrays: [] },
  structure: { objects: ["verses"], arrays: ["segments", "moves"] },
  voices: { objects: ["narrator", "verses"], arrays: ["speeches"] },
  people: { objects: ["entities", "mentions"], arrays: [] },
  notes: { objects: [], arrays: ["notes", "questions"] },
  terms: { objects: ["words", "terms"], arrays: [] },
}

/** A layer file for `book`, or null when `raw` is not one. */
export function parseLayer<L extends BkpLayer>(layer: L, book: string, raw: unknown): BkpLayerData[L] | null {
  if (!isRecord(raw) || raw.book !== book) return null
  const shape = LAYER_SHAPES[layer]
  if (!shape.objects.every((field) => isRecord(raw[field]))) return null
  if (!shape.arrays.every((field) => Array.isArray(raw[field]))) return null
  return raw as unknown as BkpLayerData[L]
}
