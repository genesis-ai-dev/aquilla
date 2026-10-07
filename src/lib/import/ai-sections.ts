// AI section milestones from scored cell boundaries (AQU-1387).
//
// A file that carries no structure of its own gets divided every 50 cells
// ("Part 1", "Part 2", …) or, for media, into fixed 5-minute buckets. Both
// numbers are arbitrary: a division lands mid-sentence as often as not, and the
// label tells a translator nothing about what is inside it. Navigation and
// assignment units should match MEANING.
//
// AQU-1386 already scores every seam (the boundary between two adjacent cells)
// with a `boundary_level` from 0 to 4 and caches it against the cells' source
// event ids. This module is the consumer of those cached levels: level 4 seams
// become section milestones, and `./passages.ts` thresholds the SAME answers at
// level 3 for the passage layer. No second classifier — one scorer, two
// readers, which is why the levels are cached with a distribution rather than a
// single drafting boolean.
//
// Two rules this module exists to keep, both of them load-bearing:
//
//   1. Structure the file already has ALWAYS wins. This module never sees an
//      explicit milestone: callers only reach it where they would otherwise
//      have emitted `part` or `time-range`, both of which are app-invented.
//   2. No scores, no change. An unscored (or barely scored) file keeps the
//      fixed-size fallback exactly as it is today. The scorer is best-effort by
//      design — it runs in the background after import and can be off, down, or
//      mid-run — so "degrade to today's behaviour" is the normal path, not an
//      error path.
//
// Keep this module pure: no DOM, no storage, no i18n, no `@/` aliases. The
// shadow eval (`scripts/ai-sections-eval.ts`) runs it under tsx, and the
// caller supplies vocabulary through `fallbackLabel` precisely so that no
// translatable string is minted here.

import type { ImportMilestone } from "../../../shared/import-contract"

/** Seam strength, as defined by AQU-1386's `boundary_level` question. */
export type BoundaryLevel = 0 | 1 | 2 | 3 | 4

/** A new paragraph, pericope, or exercise — the passage layer's threshold. */
export const PASSAGE_BOUNDARY_LEVEL = 3
/** A new section or chapter-level topic — the milestone layer's threshold. */
export const SECTION_BOUNDARY_LEVEL = 4

/**
 * One scored seam, as cached by AQU-1386's seam store.
 *
 * `confidence` is optional because a heuristic decision has no calibrated
 * confidence to report; absent is read as "no reason to doubt it", not as zero.
 */
export interface ScoredBoundary {
  level: BoundaryLevel
  /** 0 = coin flip, 1 = certain. */
  confidence?: number
  decidedBy?: "model" | "heuristic"
}

/**
 * The seam AFTER `index`, i.e. between cell `index` and cell `index + 1`.
 *
 * `undefined` means "not scored", which is NOT the same as "no boundary here":
 * see `MIN_SCORED_COVERAGE`. Keeping this a function rather than an array is
 * what lets the SPA hand over its IndexedDB-backed seam cache and the eval
 * hand over a fixture without either knowing about the other.
 */
export type BoundarySource = (index: number) => ScoredBoundary | undefined

/** The cells being divided, in file order. */
export interface SectionPlanCell {
  /** Stable identity — becomes part of the milestone key. */
  key: string
  /** Source text; a section is labelled with its opening words. */
  text: string
  /** Timeline start, when the cell has one. */
  startMs?: number
  /** Timeline end, when the cell has one. */
  endMs?: number
}

export interface AiSectionOptions {
  /**
   * Smallest section worth navigating to. Below this, a division is noise in
   * the picker — a "section" holding one verse helps nobody — so short runs
   * merge into their neighbour even though the model called the boundary
   * strong.
   */
  minUnits?: number
  /**
   * Largest section a translator can still scroll as one unit. Chosen near the
   * old fixed size so navigation density stays familiar rather than swinging by
   * an order of magnitude the first time the scorer runs.
   */
  maxUnits?: number
  /**
   * Below this confidence the level is ignored and the seam is treated as no
   * boundary. Gating on confidence is the point of using a calibrated model: an
   * unsure classifier that still votes is worse than the fixed size it replaced.
   */
  minConfidence?: number
  /** Prefix each label with the section's clock range (media/timeline files). */
  clockPrefix?: boolean
  /**
   * Vocabulary for a section whose cells are all empty, e.g. `(n) => "Section
   * ${n}"`. Supplied by the caller so this module mints no translatable text.
   */
  fallbackLabel?: (ordinal: number) => string
}

export const AI_SECTION_MIN_UNITS = 8
export const AI_SECTION_MAX_UNITS = 60
export const AI_SECTION_MIN_CONFIDENCE = 0.4

/**
 * Share of a file's seams that must be scored before AI sections are used.
 *
 * Classification runs in windows in the background, so a file is briefly
 * *partly* scored. Dividing on a partial read would make the navigator's
 * sections move under the translator as later windows land — worse than a
 * stable-but-arbitrary "Part 3". At 80% the remaining gaps are individual
 * unkeyable seams (a cell with no source event yet), which read as "no
 * boundary" without meaningfully moving a division.
 */
export const MIN_SCORED_COVERAGE = 0.8

export interface AiSection {
  /** First cell of the section, by index into the input. */
  startIndex: number
  /** Last cell of the section, inclusive. */
  endIndex: number
  milestone: ImportMilestone
}

/**
 * Divide `cells` at level-4 seams, or return `null` to mean "keep whatever
 * fallback you already have".
 *
 * `null` — not an empty array and not a throw — is the contract every caller
 * relies on to leave today's behaviour untouched when the scorer has nothing to
 * say. There are exactly three ways to get it: no cells, no scored seams, or
 * coverage below `MIN_SCORED_COVERAGE`.
 */
export function planAiSections(
  cells: readonly SectionPlanCell[],
  boundaries: BoundarySource,
  options: AiSectionOptions = {},
): AiSection[] | null {
  if (cells.length === 0) return null

  const minUnits = Math.max(1, options.minUnits ?? AI_SECTION_MIN_UNITS)
  const maxUnits = Math.max(minUnits, options.maxUnits ?? AI_SECTION_MAX_UNITS)
  const minConfidence = options.minConfidence ?? AI_SECTION_MIN_CONFIDENCE

  const seams = scoreSeams(cells.length, boundaries)
  if (!seams) return null

  const breaks: number[] = []
  for (let index = 0; index < seams.length; index += 1) {
    if (isBreakAt(seams[index], SECTION_BOUNDARY_LEVEL, minConfidence)) breaks.push(index)
  }

  let ranges = rangesFromBreaks(breaks, cells.length)
  ranges = mergeShortRanges(ranges, minUnits)
  ranges = splitLongRanges(ranges, seams, maxUnits, minUnits)

  return ranges.map((range, ordinal) => ({
    startIndex: range.start,
    endIndex: range.end,
    milestone: sectionMilestone(cells, range, ordinal + 1, options),
  }))
}

/**
 * Positional milestone assignment — one entry per cell, the shape
 * `planImportMilestones` and `deriveMilestoneNavigation` both work in. `null`
 * carries the same "keep your fallback" meaning as `planAiSections`.
 */
export function aiSectionMilestones(
  cells: readonly SectionPlanCell[],
  boundaries: BoundarySource,
  options: AiSectionOptions = {},
): ImportMilestone[] | null {
  const sections = planAiSections(cells, boundaries, options)
  if (!sections) return null
  const assignments: ImportMilestone[] = new Array(cells.length)
  for (const section of sections) {
    for (let index = section.startIndex; index <= section.endIndex; index += 1) {
      assignments[index] = section.milestone
    }
  }
  return assignments
}

// ---------------------------------------------------------------------------
// Seam reading
// ---------------------------------------------------------------------------

/**
 * Read every seam once. Returns `null` when the file is unscored or too thinly
 * scored to divide — the single place that decision is made, so both the
 * section and passage layers agree on when the scorer "has answers".
 */
export function scoreSeams(
  cellCount: number,
  boundaries: BoundarySource,
): (ScoredBoundary | undefined)[] | null {
  if (cellCount <= 1) return null
  const seams: (ScoredBoundary | undefined)[] = new Array(cellCount - 1)
  let scored = 0
  for (let index = 0; index < cellCount - 1; index += 1) {
    const boundary = normalizeBoundary(boundaries(index))
    seams[index] = boundary
    if (boundary) scored += 1
  }
  if (scored === 0) return null
  if (scored / seams.length < MIN_SCORED_COVERAGE) return null
  return seams
}

/** Drop anything that is not a real 0–4 level rather than trusting the caller. */
function normalizeBoundary(value: ScoredBoundary | undefined): ScoredBoundary | undefined {
  if (!value) return undefined
  const { level } = value
  if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 4) {
    return undefined
  }
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.min(1, Math.max(0, value.confidence))
    : undefined
  return {
    level: level as BoundaryLevel,
    ...(confidence === undefined ? {} : { confidence }),
    ...(value.decidedBy ? { decidedBy: value.decidedBy } : {}),
  }
}

export function isBreakAt(
  seam: ScoredBoundary | undefined,
  atLeast: number,
  minConfidence: number,
): boolean {
  if (!seam) return false
  if (seam.level < atLeast) return false
  return (seam.confidence ?? 1) >= minConfidence
}

// ---------------------------------------------------------------------------
// Range shaping
// ---------------------------------------------------------------------------

interface Range {
  start: number
  end: number
}

function size(range: Range): number {
  return range.end - range.start + 1
}

function rangesFromBreaks(breaks: readonly number[], cellCount: number): Range[] {
  const starts = [0, ...breaks.map((seam) => seam + 1)]
  return starts.map((start, index) => ({
    start,
    end: (starts[index + 1] ?? cellCount) - 1,
  }))
}

/**
 * Absorb runs shorter than `minUnits` into the previous section, or into the
 * next one when the short run opens the file (there is no previous section to
 * absorb it, and a two-cell "Section 1" is exactly the noise this avoids).
 */
function mergeShortRanges(ranges: readonly Range[], minUnits: number): Range[] {
  const merged: Range[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && size(range) < minUnits) {
      previous.end = range.end
      continue
    }
    merged.push({ ...range })
  }
  // The opening range can still be short: nothing preceded it to merge into.
  while (merged.length > 1 && size(merged[0]) < minUnits) {
    merged[1].start = merged[0].start
    merged.shift()
  }
  return merged
}

/**
 * Split anything longer than `maxUnits` at its strongest internal seam,
 * repeatedly, so one weak-boundaried stretch cannot produce a 900-cell
 * "section" that is less navigable than the Part N it replaced.
 *
 * Candidates are restricted to seams that leave both halves at least
 * `minUnits` long, so the max rule cannot undo the min rule. When no scored
 * seam qualifies, the cut falls back to the midpoint — arbitrary, like today's
 * stride, but balanced, and only for the stretch that earned it.
 *
 * `maxUnits` is a hard ceiling and `minUnits` a soft floor: with sane options
 * (a ceiling at least twice the floor) both hold, and where they conflict the
 * ceiling wins, because an unnavigable section is the worse failure.
 */
function splitLongRanges(
  ranges: readonly Range[],
  seams: readonly (ScoredBoundary | undefined)[],
  maxUnits: number,
  minUnits: number,
): Range[] {
  const result: Range[] = []
  // A stack popped from the end, seeded in reverse, so sections come out in
  // file order and each half of a split can itself be split again.
  const pending = ranges.map((range) => ({ ...range })).reverse()
  while (pending.length > 0) {
    const range = pending.pop()!
    if (size(range) <= maxUnits) {
      result.push(range)
      continue
    }
    const seam = strongestInternalSeam(range, seams, minUnits)
    const cut = seam ?? range.start + Math.floor((size(range) - 1) / 2)
    pending.push({ start: cut + 1, end: range.end })
    pending.push({ start: range.start, end: cut })
  }
  return result
}

/**
 * The seam inside `range` with the highest level, breaking ties on confidence
 * and then on closeness to the middle — a tie between two equally strong
 * boundaries is best resolved by balancing the two halves.
 */
function strongestInternalSeam(
  range: Range,
  seams: readonly (ScoredBoundary | undefined)[],
  minUnits: number,
): number | undefined {
  const first = range.start + minUnits - 1
  const last = range.end - minUnits
  const middle = (range.start + range.end) / 2
  let best: number | undefined
  let bestLevel = -1
  let bestConfidence = -1
  let bestDistance = Number.POSITIVE_INFINITY
  for (let seamIndex = first; seamIndex <= last; seamIndex += 1) {
    const seam = seams[seamIndex]
    if (!seam) continue
    const confidence = seam.confidence ?? 1
    const distance = Math.abs(seamIndex + 0.5 - middle)
    const better = seam.level > bestLevel
      || (seam.level === bestLevel && confidence > bestConfidence)
      || (seam.level === bestLevel && confidence === bestConfidence && distance < bestDistance)
    if (better) {
      best = seamIndex
      bestLevel = seam.level
      bestConfidence = confidence
      bestDistance = distance
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const MAX_LABEL_CHARS = 60

function sectionMilestone(
  cells: readonly SectionPlanCell[],
  range: Range,
  ordinal: number,
  options: AiSectionOptions,
): ImportMilestone {
  const opening = openingWords(cells, range)
  const label = options.clockPrefix
    ? joinLabel(clockRange(cells, range), opening, ordinal, options)
    : opening || options.fallbackLabel?.(ordinal) || String(ordinal)
  return {
    key: `ai-section:${cells[range.start]?.key ?? ordinal}`,
    kind: "ai-section",
    label,
    shortLabel: String(ordinal),
  }
}

function joinLabel(
  clock: string | undefined,
  opening: string,
  ordinal: number,
  options: AiSectionOptions,
): string {
  const fallback = options.fallbackLabel?.(ordinal) || String(ordinal)
  if (!clock) return opening || fallback
  return opening ? `${clock} · ${opening}` : clock
}

/**
 * The section's first words, taken from the first cell that actually has text.
 * An empty opening cell (a blank line, an untranslated cue) must not produce an
 * unlabelled division.
 */
function openingWords(cells: readonly SectionPlanCell[], range: Range): string {
  for (let index = range.start; index <= range.end; index += 1) {
    const compact = compactLabel(cells[index]?.text ?? "")
    if (compact) return compact
  }
  return ""
}

function compactLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= MAX_LABEL_CHARS) return normalized
  const clipped = normalized.slice(0, MAX_LABEL_CHARS - 1)
  const lastSpace = clipped.lastIndexOf(" ")
  // Clip on a word boundary when there is one late enough to keep most of the
  // text; mid-word truncation reads like a bug in scripts without spaces.
  const stem = lastSpace > MAX_LABEL_CHARS / 2 ? clipped.slice(0, lastSpace) : clipped
  return `${stem.trimEnd()}…`
}

function clockRange(cells: readonly SectionPlanCell[], range: Range): string | undefined {
  const start = cells[range.start]?.startMs
  if (start === undefined) return undefined
  let end: number | undefined
  for (let index = range.end; index >= range.start; index -= 1) {
    end = cells[index]?.endMs ?? cells[index]?.startMs
    if (end !== undefined) break
  }
  return end === undefined || end <= start
    ? formatClock(start)
    : `${formatClock(start)}–${formatClock(end)}`
}

export function formatClock(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}
