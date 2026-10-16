// Text direction for the editor. The language→direction table, the
// `ltr | rtl | auto` vocabulary and the project-settings resolution rule are
// SHARED with the workers (db/shared/text-direction.ts) since AQU-1471 — the
// Agent API has to report the same answer the editor renders. Everything below
// is the browser-only half: detection from the text itself, and the per-lane
// summaries the editor's direction controls read.

export {
  languageDefaultDirection,
  normalizeDirectionMode,
  normalizeLanguageToken,
  normalizeTextDirection,
  projectSettingTextDirection,
  resolveProjectTextDirection,
  TEXT_DIRECTION_SETTING_VALUES,
} from "../../db/shared/text-direction"
export type {
  DirectionMode,
  TextDirection,
  TextDirectionSettings,
  TextDirectionSide,
} from "../../db/shared/text-direction"

import type { TextDirection, DirectionMode } from "../../db/shared/text-direction"

export type TextDirectionSummary = TextDirection | "mixed"

/** Strong RTL Unicode ranges: Hebrew, Arabic, Syriac, Thaana, NKo,
 * Samaritan, Arabic Extended, Arabic Presentation Forms. */
const RTL_CHAR_RE =
  /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u0780-\u07bf\u07c0-\u07ff\u0800-\u083f\u0840-\u085f\u0860-\u086f\u0870-\u089f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/

/** Strong LTR ranges we expect in project text: Latin, IPA, Greek, Cyrillic,
 * Armenian, Georgian, Ethiopic, Cherokee, Canadian syllabics, Hangul, CJK. */
const LTR_CHAR_RE =
  /[A-Za-z\u00c0-\u02af\u0370-\u052f\u0530-\u058f\u10a0-\u10ff\u1200-\u137f\u13a0-\u13ff\u1400-\u167f\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af]/

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, "&")
}

export function stripDirectionMarkup(value: string | undefined | null): string {
  if (!value) return ""
  return decodeBasicEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\\f[\s\S]*?\\f\*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function detectStrongTextDirection(value: string | undefined | null): TextDirection | null {
  const text = stripDirectionMarkup(value)
  for (const char of text) {
    if (RTL_CHAR_RE.test(char)) return "rtl"
    if (LTR_CHAR_RE.test(char)) return "ltr"
  }
  return null
}

export function summarizeTextDirections(values: Iterable<string | undefined | null>): TextDirectionSummary | null {
  return summarizeDetectedDirections(detectEach(values))
}

function* detectEach(values: Iterable<string | undefined | null>): Iterable<TextDirection | null> {
  for (const value of values) yield detectStrongTextDirection(value)
}

/**
 * Same summary as `summarizeTextDirections`, over directions the caller has
 * already detected (and can therefore cache per cell; AQU-1104).
 */
export function summarizeDetectedDirections(directions: Iterable<TextDirection | null>): TextDirectionSummary | null {
  let hasLtr = false
  let hasRtl = false
  for (const direction of directions) {
    if (direction === "ltr") hasLtr = true
    if (direction === "rtl") hasRtl = true
    if (hasLtr && hasRtl) return "mixed"
  }
  if (hasRtl) return "rtl"
  if (hasLtr) return "ltr"
  return null
}

/** Summarize both editor lanes in one pass over cached cell directions. */
export function summarizePairedDirections<T>(
  values: Iterable<T>,
  read: (value: T) => { source: TextDirection | null; target: TextDirection | null },
): { source: TextDirectionSummary | null; target: TextDirectionSummary | null } {
  let sourceLtr = false
  let sourceRtl = false
  let targetLtr = false
  let targetRtl = false
  for (const value of values) {
    const directions = read(value)
    if (directions.source === "ltr") sourceLtr = true
    if (directions.source === "rtl") sourceRtl = true
    if (directions.target === "ltr") targetLtr = true
    if (directions.target === "rtl") targetRtl = true
    if (sourceLtr && sourceRtl && targetLtr && targetRtl) break
  }
  return {
    source: sourceLtr && sourceRtl ? "mixed" : sourceRtl ? "rtl" : sourceLtr ? "ltr" : null,
    target: targetLtr && targetRtl ? "mixed" : targetRtl ? "rtl" : targetLtr ? "ltr" : null,
  }
}

export function resolveTextDirection(
  mode: DirectionMode,
  text: string | undefined | null,
  fallback: TextDirection,
): TextDirection {
  if (mode === "ltr" || mode === "rtl") return mode
  return detectStrongTextDirection(text) ?? fallback
}

export function resolveDefaultDirection(mode: DirectionMode, fallback: TextDirection): TextDirection {
  return mode === "auto" ? fallback : mode
}
