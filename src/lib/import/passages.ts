// Suggested passages — the pericope layer (AQU-1387, serving AQU-515).
//
// Chapters and verses are addresses, not working units. The unit a translator
// actually drafts and reviews is the PASSAGE: "the call of Levi", "exercise 5",
// "the second half of the interview". Scripture files carry chapter milestones
// and no passage layer at all; everything else carries nothing.
//
// Two sources, ONE shape. Which one decides a boundary depends on whether the
// cells carry scripture addresses the dataset knows:
//
//   * section-counts — the CC0 OpenBible dataset (`./section-boundaries.ts`):
//     for each verse, how many of 20 published translations begin a section
//     there. Twenty human editorial teams agreeing where Luke 5 breaks beats
//     any model we could run, so for Bible text the dataset is PRIMARY.
//   * model — AQU-1386's cached seam levels, thresholded at 3. This covers
//     every file the dataset cannot speak to: EBL workbooks, prose, media
//     transcripts, and the gaps inside Bibles (deuterocanon, verse bridges,
//     versification the dataset does not index).
//
// Passages are additive. They never replace the chapter (or slide, or story)
// milestones a file already has — `suggestPassages` returns them beside the
// milestone assignment, and a caller layers them underneath.

import type { ImportPassage } from "../../../shared/import-contract"
import {
  PASSAGE_BOUNDARY_LEVEL,
  isBreakAt,
  scoreSeams,
  type BoundarySource,
  type ScoredBoundary,
} from "./ai-sections"
import {
  SECTION_COUNT_TRANSLATIONS,
  type SectionBoundaryIndex,
} from "./section-boundaries"

export interface PassagePlanCell {
  /** Stable identity — becomes part of the passage key. */
  key: string
  /** Source text; a passage with no verse range is labelled with its first words. */
  text: string
  /** Canonical scripture reference, e.g. `LUK 5:12`, when the cell has one. */
  ref?: string
}

export interface PassageOptions {
  /**
   * The CC0 section-counts index. Omit it and every file is scored by the
   * model — which is exactly what happens for a non-scripture file, so the
   * absent-dataset path is the common path, not a degraded one.
   */
  sectionBoundaries?: SectionBoundaryIndex
  /**
   * Translations (of 20) that must start a section at a verse for the dataset
   * to call it a passage boundary. Five is a quarter of the panel: below that a
   * "boundary" is one or two houses' idiosyncratic choice, and Luke 5's real
   * breaks all sit at 18–19.
   */
  minTranslations?: number
  /** Confidence gate on model levels — see `AI_SECTION_MIN_CONFIDENCE`. */
  minConfidence?: number
}

export const PASSAGE_MIN_TRANSLATIONS = 5
export const PASSAGE_MIN_CONFIDENCE = 0.4

/**
 * A model boundary with no calibrated confidence attached.
 *
 * Deliberately mid-scale: it must not outrank a 20/20 dataset boundary when a
 * caller sorts suggestions by strength, and must not read as a coin flip
 * either — the level itself was still an assertion.
 */
const UNSCORED_MODEL_STRENGTH = 0.5

/**
 * Passages covering every cell, in file order. Empty when there is nothing to
 * divide and when the model has no answers for a non-scripture file: an empty
 * list means "no suggestions", which a caller shows as nothing rather than as a
 * single passage spanning the file.
 */
export function suggestPassages(
  cells: readonly PassagePlanCell[],
  boundaries: BoundarySource,
  options: PassageOptions = {},
): ImportPassage[] {
  if (cells.length === 0) return []
  const minTranslations = options.minTranslations ?? PASSAGE_MIN_TRANSLATIONS
  const minConfidence = options.minConfidence ?? PASSAGE_MIN_CONFIDENCE
  const dataset = options.sectionBoundaries

  const seams = scoreSeams(cells.length, boundaries)
  // The file's first cell always opens a passage; only its provenance varies.
  // Its strength is 1 because the start of a file is not a judgment either
  // source made — a caller ranking suggestions should never rank it last.
  const starts: { index: number; strength: number; source: ImportPassage["source"] }[] = [{
    index: 0,
    strength: 1,
    source: dataset && datasetSpeaksFor(cells[0], dataset) ? "section-counts" : "model",
  }]

  for (let index = 1; index < cells.length; index += 1) {
    const cell = cells[index]
    // Dataset first, and only where it actually has an opinion about this
    // chapter. "Silent" and "says no boundary" are different answers.
    if (dataset && datasetSpeaksFor(cell, dataset)) {
      const translations = translationsAt(cell, dataset) ?? 0
      if (translations >= minTranslations) {
        starts.push({
          index,
          strength: translations / SECTION_COUNT_TRANSLATIONS,
          source: "section-counts",
        })
      }
      continue
    }
    const seam = seams?.[index - 1]
    if (isBreakAt(seam, PASSAGE_BOUNDARY_LEVEL, minConfidence)) {
      starts.push({ index, strength: modelStrength(seam), source: "model" })
    }
  }

  // A lone opening "passage" spanning the whole file is not a suggestion.
  if (starts.length === 1) return []

  return starts.map((start, ordinal) => {
    const end = (starts[ordinal + 1]?.index ?? cells.length) - 1
    return passage(cells, start.index, end, start.strength, start.source)
  })
}

/**
 * The next `count` passages after the one containing `afterUnitKey` — the
 * "suggest the next few ranges" call AQU-515's UX makes. An unknown key (a cell
 * from a different file, a stale selection) yields the first `count`, so the
 * flow always has something to offer.
 */
export function nextPassageSuggestions(
  passages: readonly ImportPassage[],
  afterUnitKey: string | undefined,
  count: number,
): ImportPassage[] {
  if (count <= 0) return []
  const current = afterUnitKey === undefined
    ? -1
    : passages.findIndex((value) => value.startUnitKey === afterUnitKey
      || value.endUnitKey === afterUnitKey)
  return passages.slice(current + 1, current + 1 + count)
}

// ---------------------------------------------------------------------------
// Scripture references
// ---------------------------------------------------------------------------

export interface VerseRef {
  book: string
  chapter: number
  /** First verse of the reference; a bridge (`5:1-2`) reports its opening verse. */
  verse: number
}

/**
 * Parse `LUK 5:12`, `1CO 13:4-7`, `GEN 1:1a`. Returns `undefined` for
 * structural refs (`GEN 2:s1:1`) and anything unparseable — a ref we cannot
 * resolve to a verse is a ref the dataset cannot be asked about, which routes
 * the seam to the model instead of guessing.
 */
export function parseVerseRef(value: string | null | undefined): VerseRef | undefined {
  // A structural ref (`GEN 2:s1:1`) carries a marker where the verse belongs,
  // so requiring digits after the colon rejects it without a second check.
  const match = value?.trim().match(/^([1-3]?[A-Za-z]{2,3})\s+(\d+):(\d+)/)
  if (!match) return undefined
  const chapter = Number(match[2])
  const verse = Number(match[3])
  if (!Number.isFinite(chapter) || !Number.isFinite(verse)) return undefined
  return { book: match[1].toUpperCase(), chapter, verse }
}

function datasetSpeaksFor(
  cell: PassagePlanCell | undefined,
  dataset: SectionBoundaryIndex,
): boolean {
  const ref = parseVerseRef(cell?.ref)
  return ref ? dataset.covers(ref.book, ref.chapter) : false
}

function translationsAt(
  cell: PassagePlanCell | undefined,
  dataset: SectionBoundaryIndex,
): number | undefined {
  const ref = parseVerseRef(cell?.ref)
  return ref ? dataset.strengthAt(ref.book, ref.chapter, ref.verse) : undefined
}

function modelStrength(seam: ScoredBoundary | undefined): number {
  return seam?.confidence ?? UNSCORED_MODEL_STRENGTH
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

const MAX_LABEL_CHARS = 60

function passage(
  cells: readonly PassagePlanCell[],
  startIndex: number,
  endIndex: number,
  strength: number,
  source: ImportPassage["source"],
): ImportPassage {
  const start = cells[startIndex]
  const end = cells[endIndex]
  const startRef = parseVerseRef(start?.ref)
  const endRef = parseVerseRef(end?.ref)
  return {
    key: `passage:${start?.key ?? startIndex}`,
    label: verseRangeLabel(startRef, endRef) ?? openingWords(cells, startIndex, endIndex),
    startUnitKey: start?.key ?? "",
    endUnitKey: end?.key ?? start?.key ?? "",
    unitCount: endIndex - startIndex + 1,
    ...(start?.ref ? { startRef: start.ref } : {}),
    ...(end?.ref ? { endRef: end.ref } : {}),
    strength: Math.min(1, Math.max(0, strength)),
    source,
  }
}

/**
 * `Luke 5:1–11` beats `And it came to pass…` when both edges are verses — the
 * range is what a translator assigns and reports against. Book codes stay as
 * imported: resolving them to names is a display concern, and this label is
 * consumed by callers that already localize book names.
 */
function verseRangeLabel(
  start: VerseRef | undefined,
  end: VerseRef | undefined,
): string | undefined {
  if (!start) return undefined
  if (!end || end.book !== start.book) return `${start.book} ${start.chapter}:${start.verse}`
  if (end.chapter !== start.chapter) {
    return `${start.book} ${start.chapter}:${start.verse}–${end.chapter}:${end.verse}`
  }
  if (end.verse === start.verse) return `${start.book} ${start.chapter}:${start.verse}`
  return `${start.book} ${start.chapter}:${start.verse}–${end.verse}`
}

function openingWords(
  cells: readonly PassagePlanCell[],
  startIndex: number,
  endIndex: number,
): string {
  for (let index = startIndex; index <= endIndex; index += 1) {
    const normalized = (cells[index]?.text ?? "").replace(/\s+/g, " ").trim()
    if (!normalized) continue
    if (normalized.length <= MAX_LABEL_CHARS) return normalized
    const clipped = normalized.slice(0, MAX_LABEL_CHARS - 1)
    const lastSpace = clipped.lastIndexOf(" ")
    const stem = lastSpace > MAX_LABEL_CHARS / 2 ? clipped.slice(0, lastSpace) : clipped
    return `${stem.trimEnd()}…`
  }
  return ""
}
