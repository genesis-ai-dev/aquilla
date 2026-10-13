// Voices, the label chain (AQU-1687): which name a speaker or addressee shows.
//
//   1. Project names: the project's own agreed rendering, from terminology.
//   2. Interface language: the pack's label in the UI language.
//   3. English.
//
// Each person picks how far up the chain to start (View settings → Bible
// data → Label language). The result says which step answered, as a reason
// code; the UI turns it into words ("From your terminology").
//
// Pure. Spec: 04-features/bible-knowledge-layer.md (Localized labels and the
// Vocabulary mapping); design doc §8.3.

import { normalizeLanguageTag } from "@/lib/language-normalize"
import { stripMarks } from "@/lib/terminology/match"
import { resolveMatchOptions } from "@/lib/terminology/match-options"
import { conceptsForSourceSurface } from "@/lib/terminology/source-lookup"
import type { Concept, TermMatchingSettings } from "@/lib/terminology/types"
import type { BkpEntity, BkpEntityId } from "./pack-types"

export const VOICE_LABEL_MODES = ["project", "interface", "english"] as const
/** Where the chain starts: project names, the interface language, or English only. */
export type VoiceLabelMode = (typeof VOICE_LABEL_MODES)[number]
export const DEFAULT_VOICE_LABEL_MODE: VoiceLabelMode = "project"

export function isVoiceLabelMode(value: unknown): value is VoiceLabelMode {
  return typeof value === "string" && (VOICE_LABEL_MODES as readonly string[]).includes(value)
}

/**
 * Which step gave the label:
 *   terminology — the project's agreed rendering;
 *   acai        — ACAI's name for the person in the interface language;
 *   generated   — a name the pack made itself (from a gloss or a character
 *                 id), not yet reviewed by anyone;
 *   english     — the English name, because nothing earlier answered.
 */
export type VoiceLabelSource = "terminology" | "acai" | "generated" | "english"

export interface VoiceLabel {
  label: string
  source: VoiceLabelSource
  /** An ACAI label written in the other script of the interface language. */
  otherScript?: true
}

/** The languages ACAI (and so the pack) has person labels in, by ISO 639-3 code. */
export const ACAI_LABEL_LANGUAGES = [
  "eng", "fra", "spa", "por", "ind", "hin", "rus", "arb", "cmn", "swh", "hau", "tpi",
] as const
export type AcaiLabelLanguage = (typeof ACAI_LABEL_LANGUAGES)[number]

/**
 * After `normalizeLanguageTag`, which turns "fr", "fre" and "French" into
 * "fra". The macrolanguage codes it gives for Arabic, Chinese and Swahili map
 * to the individual languages ACAI labels.
 */
const ACAI_LANGUAGE_BY_TAG: Readonly<Record<string, AcaiLabelLanguage>> = {
  eng: "eng",
  fra: "fra",
  spa: "spa",
  por: "por",
  ind: "ind",
  hin: "hin",
  rus: "rus",
  ara: "arb",
  arb: "arb",
  zho: "cmn",
  cmn: "cmn",
  swa: "swh",
  swh: "swh",
  ha: "hau",
  hau: "hau",
  tpi: "tpi",
}

/** The pack's label language for a project or UI language code, or null when the pack has none. */
export function acaiLanguageFor(code: string | null | undefined): AcaiLabelLanguage | null {
  const tag = normalizeLanguageTag(code)
  return Object.hasOwn(ACAI_LANGUAGE_BY_TAG, tag) ? ACAI_LANGUAGE_BY_TAG[tag] : null
}

/**
 * Chinese in the pack (AQU-1700). Since pack 1.2.0 every label map (names,
 * descriptions, key-term titles) is keyed by one scheme, ISO 639-3 plus a
 * BCP 47 script subtag where a language has two written standards:
 *   • `cmn` is Traditional characters: ACAI's labels (measured on pack 1.0.0:
 *     294 use characters only Traditional Chinese has, 耶穌, 聖靈, 馬利亞, and
 *     none Simplified-only ones) and Aquifer's `zht` titles;
 *   • `cmn-Hans` is Simplified: Aquifer's `zhs`, which no source fills yet.
 * So a Simplified interface reads `cmn-Hans` first, then the Traditional
 * `cmn`, saying it is in the other script.
 */
const CHINESE_SIMPLIFIED_KEY = "cmn-Hans"

/** One pack label key the interface reads. */
export interface InterfaceLabelKey {
  /** A pack label key: "fra", "cmn-Hans", "cmn". */
  key: string
  /** Text under this key is in the other script of the interface language (Chinese only). */
  otherScript: boolean
}

export interface InterfaceLabelLanguage {
  language: AcaiLabelLanguage
  /** The pack keys to read, best first. */
  keys: readonly InterfaceLabelKey[]
}

/**
 * The pack's label language for a UI locale: en, fr, id, ru, ar, zh-Hans and
 * zh-Hant have one; ms, my and th do not, so they fall back to English.
 */
export function acaiLanguageForLocale(locale: string): InterfaceLabelLanguage | null {
  const language = acaiLanguageFor(locale)
  if (!language) return null
  const script = /-(hans|hant)\b/i.exec(locale)?.[1]?.toLowerCase()
  if (language === "cmn" && script === "hans") {
    return {
      language,
      keys: [
        { key: CHINESE_SIMPLIFIED_KEY, otherScript: false },
        { key: "cmn", otherScript: true },
      ],
    }
  }
  return { language, keys: [{ key: language, otherScript: false }] }
}

// ── Project names ───────────────────────────────────────────────────────────

/**
 * Concepts linked to an entity by `Concept.externalIds.acai` (AQU-1693), of
 * any status: `agreedRendering` reads only the active ones.
 */
export type ConceptsForEntity = (entityId: BkpEntityId) => readonly Concept[]

/** Concepts by the ACAI id they link to (AQU-1693). */
export function linkedConceptIndex(concepts: readonly Concept[]): ReadonlyMap<string, readonly Concept[]> {
  const index = new Map<string, Concept[]>()
  for (const concept of concepts) {
    const acai = concept.externalIds?.acai
    if (!acai) continue
    const list = index.get(acai)
    if (list) list.push(concept)
    else index.set(acai, [concept])
  }
  return index
}

export interface ProjectNameSource {
  concepts: readonly Concept[]
  termMatching?: TermMatchingSettings
  /** The project's source language, when the pack has labels in it. */
  sourceLanguage: AcaiLabelLanguage | null
  /** More than one target lane share the termbase, and renderings carry no lane. */
  multiLane: boolean
  conceptsForEntity?: ConceptsForEntity
}

function foldName(value: string): string {
  return stripMarks(value.trim().toLocaleLowerCase())
}

/**
 * Active concepts whose headword, or one of its listed forms, is the whole
 * `name`. The source-surface lookup finds the candidates; the name must then
 * match a headword as a whole, so "Samaritan" never answers for
 * "Samaritan woman".
 */
export function conceptsNamed(name: string, source: Pick<ProjectNameSource, "concepts" | "termMatching">): Concept[] {
  const folded = foldName(name)
  if (!folded) return []
  return conceptsForSourceSurface(name, source.concepts, source.termMatching).filter((concept) =>
    [concept.sourceTerm, ...resolveMatchOptions(concept, source.termMatching).forms].some(
      (form) => foldName(form) === folded,
    ),
  )
}

/**
 * The agreed rendering among `concepts`: a preferred rendering, else an
 * admitted one. A rendering any of them forbids is never used. With several
 * target lanes, only a single candidate is unambiguous; otherwise null.
 */
export function agreedRendering(concepts: readonly Concept[], multiLane: boolean): string | null {
  const active = concepts.filter((concept) => concept.status === "active")
  const forbidden = new Set(
    active.flatMap((concept) =>
      concept.renderings.filter((r) => r.status === "forbidden").map((r) => foldName(r.rendering)),
    ),
  )
  const candidates: string[] = []
  for (const concept of active) {
    const usable = (status: "preferred" | "admitted") =>
      concept.renderings
        .filter((r) => r.status === status)
        .map((r) => r.rendering.trim())
        .filter((rendering) => rendering !== "" && !forbidden.has(foldName(rendering)))
    const preferred = usable("preferred")
    candidates.push(...(preferred.length > 0 ? preferred : usable("admitted")))
  }
  const distinct = [...new Set(candidates)]
  if (distinct.length === 0) return null
  if (multiLane && distinct.length > 1) return null
  return distinct[0]
}

/**
 * The project's own name for an entity, or null when it has not agreed one.
 *
 * AQU-1693: a concept linked to the entity is exact, so it decides. When an
 * active one exists, its agreed rendering is the name, or there is none (it
 * only forbids, or several lanes disagree) and the chain moves on. The headword
 * match is not asked instead: it could answer with a rendering the linked
 * concept forbids. The headword match also skips concepts linked to another
 * entity, so "Joseph" linked to one Joseph never names his namesake.
 */
export function projectNameFor(entityId: BkpEntityId, entity: BkpEntity, source: ProjectNameSource): string | null {
  const linked = (source.conceptsForEntity?.(entityId) ?? []).filter((concept) => concept.status === "active")
  if (linked.length > 0) return agreedRendering(linked, source.multiLane)
  const sourceName = source.sourceLanguage ? entity.labels[source.sourceLanguage] : undefined
  if (!sourceName) return null
  const named = conceptsNamed(sourceName, source).filter(
    (concept) => concept.externalIds?.acai === undefined || concept.externalIds.acai === entity.acai,
  )
  return agreedRendering(named, source.multiLane)
}

// ── The chain ───────────────────────────────────────────────────────────────

export interface VoiceLabelOptions {
  mode: VoiceLabelMode
  interfaceLanguage: InterfaceLabelLanguage | null
  projectNames: ProjectNameSource
}

/** The name to show for an entity, and where it came from. Null when the pack has no name for it. */
export function resolveVoiceLabel(
  entityId: BkpEntityId,
  entity: BkpEntity | undefined,
  options: VoiceLabelOptions,
): VoiceLabel | null {
  if (!entity) return null
  // ACAI's names are reviewed; the pack's own (from a gloss or a character id) are not.
  const generated = entity.labelSource !== "acai"

  if (options.mode === "project") {
    const name = projectNameFor(entityId, entity, options.projectNames)
    if (name) return { label: name, source: "terminology" }
  }

  const ui = options.mode === "english" ? null : options.interfaceLanguage
  for (const { key, otherScript } of ui?.keys ?? []) {
    const uiName = Object.hasOwn(entity.labels, key) ? entity.labels[key] : undefined
    if (!uiName) continue
    if (generated) return { label: uiName, source: "generated" }
    return otherScript ? { label: uiName, source: "acai", otherScript: true } : { label: uiName, source: "acai" }
  }

  const english = entity.labels.eng
  if (english) return { label: english, source: generated ? "generated" : "english" }
  return null
}

// ── Other text per language (AQU-1695) ──────────────────────────────────────

export interface LabelText {
  text: string
  /** The pack's language key of `text`: one of the interface language's keys, or "eng". */
  language: string
  /** In the other script of the interface language: Traditional characters for a Simplified interface. */
  otherScript?: true
}

/**
 * Pack text kept per language code, other than names: an entity's
 * description, a key term's title, a deity mention's form. In the interface
 * language unless the person reads labels in English only, else in English.
 * There is no project step: the termbase agrees names, not these. Null when
 * neither language has text; a value that is not a non-empty string is none.
 */
export function pickLabelText(
  byLanguage: Readonly<Record<string, unknown>> | undefined,
  mode: VoiceLabelMode,
  interfaceLanguage: InterfaceLabelLanguage | null,
): LabelText | null {
  if (!byLanguage) return null
  const textIn = (language: string): string | null => {
    const value = Object.hasOwn(byLanguage, language) ? byLanguage[language] : undefined
    return typeof value === "string" && value.trim() !== "" ? value : null
  }
  if (mode !== "english" && interfaceLanguage) {
    for (const { key, otherScript } of interfaceLanguage.keys) {
      const own = textIn(key)
      if (own) return otherScript ? { text: own, language: key, otherScript: true } : { text: own, language: key }
    }
  }
  const english = textIn("eng")
  return english ? { text: english, language: "eng" } : null
}
