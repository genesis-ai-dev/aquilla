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

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReplaceCandidate {
  /** Cell identifier. */
  cellId: string
  fileId: string
  /** The raw (possibly HTML) target text. */
  rawValue: string
  /** Event-chain head for parent-chain fencing (FRO-247). */
  parentId: string | null
  /** Source-side event_id for AD-9 staleness pin. */
  sourceEventId?: string | null
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
 * Case-sensitivity is controlled by `caseSensitive` (default: false).
 * Regex characters in `needle` are always escaped — spec mandates regex is opt-in.
 */
export function findMatches(
  haystack: string,
  needle: string,
  caseSensitive = false,
): number[] {
  if (!needle) return []
  const flags = caseSensitive ? "g" : "gi"
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(escaped, flags)
  const indices: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(haystack)) !== null) {
    indices.push(m.index)
  }
  return indices
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
  caseSensitive = false,
): { result: string; replaced: number; skipped: number } {
  const matchIndices = findMatches(rawValue, needle, caseSensitive)
  if (matchIndices.length === 0) {
    return { result: rawValue, replaced: 0, skipped: 0 }
  }

  const needleLen = needle.length
  let replaced = 0
  let skipped = 0
  let out = ""
  let cursor = 0

  for (const idx of matchIndices) {
    // Append everything before this match verbatim.
    out += rawValue.slice(cursor, idx)
    const matchText = rawValue.slice(idx, idx + needleLen)
    if (matchSpansHtmlTag(matchText)) {
      // Skip: leave original match text intact.
      out += matchText
      skipped++
    } else {
      out += replacement
      replaced++
    }
    cursor = idx + needleLen
  }

  // Append remainder.
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
  caseSensitive = false,
): ReplaceActionResult {
  const diffs: CellReplaceDiff[] = []
  let totalReplaced = 0
  let totalSkipped = 0

  for (const c of candidates) {
    const { result, replaced, skipped } = applySingleCellReplace(
      c.rawValue,
      needle,
      replacement,
      caseSensitive,
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
    })
  }

  return { diffs, totalReplaced, totalSkipped }
}
