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
 * The script ACAI's Chinese (`cmn`) labels are written in. Measured on pack
 * 1.0.0: 294 labels use characters that only Traditional Chinese has (耶穌,
 * 聖靈, 馬利亞) and none use Simplified-only ones. So a Simplified interface
 * is the one that gets them in the other script, until the pack converts.
 */
const ACAI_CHINESE_SCRIPT = "hant"

export interface InterfaceLabelLanguage {
  language: AcaiLabelLanguage
  /** ACAI's labels are in the other script of this language (Chinese only). */
  otherScript: boolean
}

/**
 * The pack's label language for a UI locale: en, fr, id, ru, ar, zh-Hans and
 * zh-Hant have one; ms, my and th do not, so they fall back to English.
 */
export function acaiLanguageForLocale(locale: string): InterfaceLabelLanguage | null {
  const language = acaiLanguageFor(locale)
  if (!language) return null
  const script = /-(hans|hant)\b/i.exec(locale)?.[1]?.toLowerCase()
  return { language, otherScript: language === "cmn" && script !== undefined && script !== ACAI_CHINESE_SCRIPT }
}

// ── Project names ───────────────────────────────────────────────────────────

/**
 * Concepts linked to an entity by id. This is where the planned
 * `Concept.externalIds.acai` link plugs in (follow-up to AQU-1687); nothing
 * provides it yet, so names come from the source-surface match only.
 */
export type ConceptsForEntity = (entityId: BkpEntityId) => readonly Concept[]

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

/** The project's own name for an entity, or null when it has not agreed one. */
export function projectNameFor(entityId: BkpEntityId, entity: BkpEntity, source: ProjectNameSource): string | null {
  const linked = source.conceptsForEntity?.(entityId) ?? []
  const fromLink = linked.length > 0 ? agreedRendering(linked, source.multiLane) : null
  if (fromLink) return fromLink
  const sourceName = source.sourceLanguage ? entity.labels[source.sourceLanguage] : undefined
  if (!sourceName) return null
  return agreedRendering(conceptsNamed(sourceName, source), source.multiLane)
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
  const uiName = ui ? entity.labels[ui.language] : undefined
  if (ui && uiName) {
    if (generated) return { label: uiName, source: "generated" }
    return ui.otherScript ? { label: uiName, source: "acai", otherScript: true } : { label: uiName, source: "acai" }
  }

  const english = entity.labels.eng
  if (english) return { label: english, source: generated ? "generated" : "english" }
  return null
}

// ── Other text per language (AQU-1695) ──────────────────────────────────────

export interface LabelText {
  text: string
  /** The pack's language code of `text`: the interface language, or "eng". */
  language: string
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
    const own = textIn(interfaceLanguage.language)
    if (own) return { text: own, language: interfaceLanguage.language }
  }
  const english = textIn("eng")
  return english ? { text: english, language: "eng" } : null
}
