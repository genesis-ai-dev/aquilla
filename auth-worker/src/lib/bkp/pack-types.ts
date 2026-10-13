// Bible Knowledge Pack (BKP) v1, as the auth-worker reads it (AQU-1690).
//
// The contract belongs to the pipeline that builds and publishes the pack:
// bible-wiki pipeline/src/schemas/bkp.ts. The SPA mirrors it in
// src/lib/bible-data/pack-types.ts; a worker cannot import SPA code, so this
// file mirrors the same four layers and the manifest. Keep the three in step.
//
// Like the SPA, the worker checks each file's ENVELOPE only: the right kind of
// object, for the right book, with the top-level fields its layer needs. That
// turns a wrong file, an HTML error page or a truncated download into
// `invalid` before any reader sees it, without re-running the pipeline's
// field-by-field checks on several MB per book.

/** The layers autopilot reads. `notes` and `terms` have no schema yet (AQU-1685). */
export const SERVER_BKP_LAYERS = ["text", "structure", "voices", "people"] as const
export type ServerBkpLayer = (typeof SERVER_BKP_LAYERS)[number]

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
  verses: Record<string, string[]>
  words: Record<string, BkpWord>
}

export interface BkpStructureVerse {
  question: boolean
  imperative: boolean
  numerals: string[]
  negators: string[]
  vocatives: string[]
}

export interface BkpStructureLayer {
  book: string
  segments: { id: string; from: string; to: string; title: string }[]
  moves: { from: string; to: string; final: string }[]
  verses: Record<string, BkpStructureVerse>
}

export interface BkpSpeech {
  id: string
  from: string
  to: string
  depth: number
  level: number
  parent: string | null
  selfProjected: boolean
  projector?: string
  speaker?: string
  speakerConf: number
  speakerSources: string[]
  addressee?: string
  addresseeConf?: number
  addresseeSources?: string[]
  type?: string
  delivery?: string
  fcbh?: string
}

export interface BkpVoicesLayer {
  book: string
  narrator: { kind: "narrator" | "author"; entity?: string }
  speeches: BkpSpeech[]
  verses: Record<string, { speech: string; from: string; to: string; opens: boolean; closes: boolean }[]>
}

export interface BkpEntity {
  type: "person" | "group" | "deity" | "place" | "local-person" | "local-group"
  acai?: string
  gender?: string
  genderSource?: "acai" | "grammatical"
  labels: Record<string, string>
  labelSource: "acai" | "fcbh" | "gloss"
  members?: string[]
  anchor?: string
  mergedFrom?: string[]
}

export interface BkpMention {
  entity: string
  kind: "explicit" | "pronoun" | "subject"
  src: "acai" | "macula" | "acai+macula"
  hops: number
  conf: number
}

export interface BkpPeopleLayer {
  book: string
  entities: Record<string, BkpEntity>
  mentions: Record<string, BkpMention>
}

export interface ServerBkpLayerData {
  text: BkpTextLayer
  structure: BkpStructureLayer
  voices: BkpVoicesLayer
  people: BkpPeopleLayer
}

export interface BkpManifest {
  pack: "bkp"
  version: string
  builtAt: string
  versification: "org"
  books: Record<string, { layers: string[]; bytes: Record<string, number> }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A manifest, or null when `raw` is not one. Every book entry is checked: the loader reads them. */
export function parseServerManifest(raw: unknown): BkpManifest | null {
  if (!isRecord(raw)) return null
  if (raw.pack !== "bkp" || raw.versification !== "org") return null
  if (typeof raw.version !== "string" || raw.version === "" || typeof raw.builtAt !== "string") return null
  if (!isRecord(raw.books)) return null
  for (const entry of Object.values(raw.books)) {
    if (!isRecord(entry) || !isRecord(entry.bytes) || !Array.isArray(entry.layers)) return null
    if (!entry.layers.every((layer) => typeof layer === "string")) return null
  }
  return raw as unknown as BkpManifest
}

const LAYER_SHAPES: Readonly<Record<ServerBkpLayer, { objects: readonly string[]; arrays: readonly string[] }>> = {
  text: { objects: ["verses", "words"], arrays: [] },
  structure: { objects: ["verses"], arrays: ["segments", "moves"] },
  voices: { objects: ["narrator", "verses"], arrays: ["speeches"] },
  people: { objects: ["entities", "mentions"], arrays: [] },
}

/** A layer file for `book`, or null when `raw` is not one. */
export function parseServerLayer<L extends ServerBkpLayer>(
  layer: L,
  book: string,
  raw: unknown,
): ServerBkpLayerData[L] | null {
  if (!isRecord(raw) || raw.book !== book) return null
  const shape = LAYER_SHAPES[layer]
  if (!shape.objects.every((field) => isRecord(raw[field]))) return null
  if (!shape.arrays.every((field) => Array.isArray(raw[field]))) return null
  return raw as unknown as ServerBkpLayerData[L]
}
