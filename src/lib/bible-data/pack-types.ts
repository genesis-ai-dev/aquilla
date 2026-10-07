// Bible Knowledge Pack (BKP) v1, as the SPA reads it (AQU-1686).
//
// The contract is owned by the pipeline that builds and publishes the pack:
// bible-wiki pipeline/src/schemas/bkp.ts (zod schemas, checked at build time
// before anything is published). These types mirror it; keep them in step.
//
// The SPA checks each file's envelope only: the right kind of object, for the
// right book, with the top-level fields its layer needs. That is enough to
// turn a wrong file, an HTML error page or a truncated download into
// `invalid` before any renderer sees it, without re-running the pipeline's
// field-by-field checks on several MB per book.

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

export type BkpEntityType = "person" | "group" | "deity" | "place" | "local-person" | "local-group"

export interface BkpEntity {
  type: BkpEntityType
  acai?: string
  gender?: string
  genderSource?: "acai" | "grammatical"
  /** Label per language code. */
  labels: Record<string, string>
  labelSource: "acai" | "fcbh" | "gloss"
  members?: BkpEntityId[]
  anchor?: BkpWordId
  mergedFrom?: BkpWordId[]
}

export interface BkpMention {
  entity: BkpEntityId
  kind: "explicit" | "pronoun" | "subject"
  src: "acai" | "macula" | "acai+macula"
  hops: number
  conf: number
}

export interface BkpPeopleLayer {
  book: string
  entities: Record<BkpEntityId, BkpEntity>
  mentions: Record<BkpWordId, BkpMention>
}

/**
 * TODO(AQU-1685): `notes` and `terms` have no schema in the pipeline yet
 * (bible-wiki pipeline/src/schemas/bkp.ts covers text, structure, voices and
 * people). Type them from there when they land; until then only the
 * envelope is known.
 */
export interface BkpEnvelope {
  book: string
  [field: string]: unknown
}

/** What each layer's file holds. */
export interface BkpLayerData {
  text: BkpTextLayer
  structure: BkpStructureLayer
  voices: BkpVoicesLayer
  people: BkpPeopleLayer
  notes: BkpEnvelope
  terms: BkpEnvelope
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
  notes: { objects: [], arrays: [] },
  terms: { objects: [], arrays: [] },
}

/** A layer file for `book`, or null when `raw` is not one. */
export function parseLayer<L extends BkpLayer>(layer: L, book: string, raw: unknown): BkpLayerData[L] | null {
  if (!isRecord(raw) || raw.book !== book) return null
  const shape = LAYER_SHAPES[layer]
  if (!shape.objects.every((field) => isRecord(raw[field]))) return null
  if (!shape.arrays.every((field) => Array.isArray(raw[field]))) return null
  return raw as unknown as BkpLayerData[L]
}
