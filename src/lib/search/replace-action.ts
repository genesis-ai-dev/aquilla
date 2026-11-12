/**
 * replace-action.ts — Pure, side-effect-free search-and-replace logic for
 * the ParallelPassagesPanel replace mode.
 *
 * The functions here compute diffs and replacement payloads only — they do
 * NOT enqueue events or touch the DOM. Callers (the panel) own the commit
 * path via emitTargetCellCommit.
 *
 * Spec: aquilla-specs/04-features/search.md → "Search-and-replace invariants"
 * Story: aquilla-specs/05-user-stories/search-and-replace-passages.md
 */

import {
  findPatternError,
  findTextMatches,
  replacementForMatch,
  type TextReplaceOptions,
} from "../../../db/shared/find-pattern"

export type { TextReplaceOptions }

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReplaceCandidate {
  /** Cell identifier. */
  cellId: string
  fileId: string
  /** The raw (possibly HTML) target text. */
  rawValue: string
  /** Event-chain head for parent-chain fencing (AQU-247). */
  parentId: string | null
  /** Source-side event_id for AD-9 staleness pin. */
  sourceEventId?: string | null
  /**
   * The cell's source text, shown beside the target diff so a reviewer can
   * judge the replacement. Null when the cell has no source row.
   */
  sourceText?: string | null
}

/** One replacement diff for a single cell. */
export interface CellReplaceDiff {
  cellId: string
  fileId: string
  parentId: string | null
  sourceEventId?: string | null
  /** Original (unmodified) value for preview display. */
  before: string
  /** Replacement value that will be committed. */
  after: string
  /** Number of matches replaced inside this cell. */
  matchCount: number
  /** Source text for this cell, when the search result carried it. */
  sourceText: string | null
}

/** Result of computing diffs across multiple cells. */
export interface ReplaceActionResult {
  diffs: CellReplaceDiff[]
  /** Total matches replaced across all cells. */
  totalReplaced: number
  /** Count of matches that were skipped because they span HTML tag boundaries. */
  totalSkipped: number
}

// ── HTML-spanning detection ──────────────────────────────────────────────────

/**
 * Returns true if the literal string `needle` appears in `haystack` across
 * an HTML tag boundary — i.e. the match region contains `<` or `>`.
 *
 * Per spec: matches that span HTML tag boundaries are silently skipped to
 * preserve rich-text structure.
 */
export function matchSpansHtmlTag(matchText: string): boolean {
  return /<|>/.test(matchText)
}

// ── Core replace helpers ──────────────────────────────────────────────────────

/**
 * Find all non-overlapping occurrences of `needle` in `haystack`, returning
 * their start indices.
 *
 * A boolean third argument is `matchCase` (default false), kept so existing
 * callers stay valid. Pass `TextReplaceOptions` for whole word and regexp.
 * Regex characters are escaped unless `useRegexp` is set.
 */
export function findMatches(
  haystack: string,
  needle: string,
  caseSensitiveOrOptions: boolean | TextReplaceOptions = false,
): number[] {
  return findTextMatches(haystack, needle, asFindOptions(caseSensitiveOrOptions)).map(
    (match) => match.index,
  )
}

/**
 * Apply `replacement` for every occurrence of `needle` in `rawValue`.
 *
 * Matches that span HTML tag boundaries are counted but NOT replaced
 * (the original bytes are left in place). Returns the new string and
 * the count of skipped matches.
 *
 * @returns `{ result, replaced, skipped }`
 */
export function applySingleCellReplace(
  rawValue: string,
  needle: string,
  replacement: string,
  caseSensitiveOrOptions: boolean | TextReplaceOptions = false,
): { result: string; replaced: number; skipped: number } {
  const options = asFindOptions(caseSensitiveOrOptions)
  if (!needle || findPatternError(needle, options)) {
    return { result: rawValue, replaced: 0, skipped: 0 }
  }
  const matches = findTextMatches(rawValue, needle, options)
  if (matches.length === 0) {
    return { result: rawValue, replaced: 0, skipped: 0 }
  }

  let replaced = 0
  let skipped = 0
  let out = ""
  let cursor = 0

  for (const match of matches) {
    if (match.index < cursor) continue
    out += rawValue.slice(cursor, match.index)
    if (matchSpansHtmlTag(match.text)) {
      out += match.text
      skipped++
    } else {
      out += replacementForMatch(match, replacement, options)
      replaced++
    }
    cursor = match.index + match.text.length
  }

  out += rawValue.slice(cursor)
  return { result: out, replaced, skipped }
}

/**
 * Compute replace diffs for a batch of candidate cells.
 *
 * Cells that produce zero replacements (no match, or all matches are
 * HTML-spanning) are excluded from `diffs`.
 */
export function computeReplaceDiffs(
  candidates: ReplaceCandidate[],
  needle: string,
  replacement: string,
  caseSensitiveOrOptions: boolean | TextReplaceOptions = false,
): ReplaceActionResult {
  const options = asFindOptions(caseSensitiveOrOptions)
  const diffs: CellReplaceDiff[] = []
  let totalReplaced = 0
  let totalSkipped = 0

  for (const c of candidates) {
    const { result, replaced, skipped } = applySingleCellReplace(
      c.rawValue,
      needle,
      replacement,
      options,
    )
    totalSkipped += skipped
    if (replaced === 0) {
      // Nothing changed in this cell (might have skipped matches only).
      continue
    }
    totalReplaced += replaced
    diffs.push({
      cellId: c.cellId,
      fileId: c.fileId,
      parentId: c.parentId,
      sourceEventId: c.sourceEventId,
      before: c.rawValue,
      after: result,
      matchCount: replaced,
      sourceText: c.sourceText ?? null,
    })
  }

  return { diffs, totalReplaced, totalSkipped }
}

function asFindOptions(caseSensitiveOrOptions: boolean | TextReplaceOptions): TextReplaceOptions {
  if (typeof caseSensitiveOrOptions === "boolean") return { matchCase: caseSensitiveOrOptions }
  return caseSensitiveOrOptions
}
