/**
 * applicability.ts — pure nearest-wins resolution of the style-rule
 * applicability graph onto a single cell (AQU-934 phase 2).
 *
 * Semantics (phase-2 contract):
 *   - Only `status === "approved" && enabled` rules participate.
 *   - Specificity ladder, most → least specific:
 *       segment > passage > section > book > file > genre.
 *   - Per rule, the MOST SPECIFIC matching applicability row decides:
 *     applies/likely_applies → in, excluded → out. A tie at the same
 *     specificity (only possible for overlapping passage rows) is decided
 *     by `excluded`.
 *   - A rule with no matching row is in iff its scope is "global"; any other
 *     scope is dormant for this cell.
 *   - `likely` is true when the decision rests solely on `likely_applies`
 *     rows (no plain `applies` row at the deciding specificity).
 *
 * Inheritance is computed here at read time — nothing is materialized. The
 * module is dependency-free by design: callers inject the genre lookup
 * (src/lib/scripture/book-genres.ts) into `cellCoordinates`.
 */

import type {
  ApplicabilityTargetType,
  CellCoordinates,
  RuleApplicability,
  StyleRule,
} from "./style-rule-types"

// Most specific first. Order is the whole algorithm — see header.
const SPECIFICITY_LADDER: readonly ApplicabilityTargetType[] = [
  "segment",
  "passage",
  "section",
  "book",
  "file",
  "genre",
]

// ── Passage refs ────────────────────────────────────────────────────────────

/**
 * A canonicalRef verse span: "BOOK C:V" or "BOOK C:V-V2" (same chapter, per
 * src/lib/parsers/core-types.ts globalReferences conventions).
 */
export interface ParsedPassageRef {
  book: string
  chapter: number
  verseStart: number
  verseEnd: number
}

const PASSAGE_REF = /^\s*(\S+)\s+(\d+):(\d+)(?:\s*-\s*(\d+))?\s*$/

/**
 * Parse a canonicalRef verse span. Returns null for anything else (chapter
 * labels, prose, opaque ids, descending ranges) — unparseable refs simply
 * never participate in passage matching.
 */
export function parsePassageRef(ref: string): ParsedPassageRef | null {
  const match = PASSAGE_REF.exec(ref)
  if (!match) return null
  const verseStart = Number(match[3])
  const verseEnd = match[4] !== undefined ? Number(match[4]) : verseStart
  if (verseEnd < verseStart) return null
  return { book: match[1].toUpperCase(), chapter: Number(match[2]), verseStart, verseEnd }
}

function passagesOverlap(a: ParsedPassageRef, b: ParsedPassageRef): boolean {
  return (
    a.book === b.book &&
    a.chapter === b.chapter &&
    a.verseStart <= b.verseEnd &&
    b.verseStart <= a.verseEnd
  )
}

// ── Target-id normalization ─────────────────────────────────────────────────
// Exact-match targets are compared after light normalization so human-entered
// rows meet derived coordinates: genres lowercase ("Poetry" ≡ "poetry"), book
// codes and "BOOK CH" section labels uppercase; file/segment ids verbatim
// (trimmed) — ids are case-sensitive.

function normalizeTargetId(type: ApplicabilityTargetType, targetId: string): string {
  const trimmed = targetId.trim()
  if (type === "genre") return trimmed.toLowerCase()
  if (type === "book" || type === "section") return trimmed.toUpperCase()
  return trimmed
}

// ── Index ───────────────────────────────────────────────────────────────────

interface RuleIndexEntry {
  /** genre/file/book/section/segment rows keyed by normalized targetId. */
  exact: Map<ApplicabilityTargetType, Map<string, RuleApplicability>>
  /** Passage rows pre-parsed for span-overlap matching. */
  passages: Array<{ row: RuleApplicability; span: ParsedPassageRef }>
}

export interface ApplicabilityIndex {
  byRule: Map<string, RuleIndexEntry>
}

/**
 * Group applicability rows by rule and pre-parse passage spans. Passage rows
 * whose targetId is not a parseable verse span are dropped — they can never
 * match a cell.
 */
export function buildApplicabilityIndex(rows: RuleApplicability[]): ApplicabilityIndex {
  const byRule = new Map<string, RuleIndexEntry>()
  for (const row of rows) {
    let entry = byRule.get(row.ruleId)
    if (!entry) {
      entry = { exact: new Map(), passages: [] }
      byRule.set(row.ruleId, entry)
    }
    if (row.targetType === "passage") {
      const span = parsePassageRef(row.targetId)
      if (span) entry.passages.push({ row, span })
      continue
    }
    let byId = entry.exact.get(row.targetType)
    if (!byId) {
      byId = new Map()
      entry.exact.set(row.targetType, byId)
    }
    byId.set(normalizeTargetId(row.targetType, row.targetId), row)
  }
  return { byRule }
}

// ── Cell coordinates ────────────────────────────────────────────────────────

/** Structural subset of CellData consumed here (no hook import). */
export interface CoordinateCell {
  id: string
  /** Scripture cells carry the canonicalRef here when globalReferences are absent. */
  group?: string
  globalReferences?: string[]
}

/** Structural subset of the file record consumed here. */
export interface CoordinateFile {
  fileId: string
  /** USFM book code when the file is a scripture book. */
  bookCode?: string
}

/**
 * Derive the coordinates a cell occupies on the scope ladder.
 *
 * Ref source: the first non-empty `globalReferences` entry; falling back to
 * `group` ONLY when it parses as a verse span (for text-split content `group`
 * is an opaque UUID, never a label — see src/lib/progress/section-index.ts).
 * Section is the ref sliced at the first ":" ("LUK 1:1-2" → "LUK 1"), same
 * derivation as the sidebar's section index. Book prefers the file's
 * `bookCode`, else the ref's book token. Genre comes from the injected
 * lookup (pass `bookGenre` from src/lib/scripture/book-genres.ts).
 */
export function cellCoordinates(
  cell: CoordinateCell,
  file: CoordinateFile,
  genreOf: (bookCode: string) => string | undefined,
): CellCoordinates {
  let ref = cell.globalReferences?.find((r) => r && r.trim().length > 0)?.trim()
  if (!ref && cell.group && parsePassageRef(cell.group)) ref = cell.group.trim()

  const coords: CellCoordinates = { segment: cell.id, file: file.fileId }

  if (ref) {
    coords.passageRef = ref
    const colonIdx = ref.indexOf(":")
    coords.section = (colonIdx >= 0 ? ref.slice(0, colonIdx) : ref).trim()
  }

  const book = file.bookCode?.trim().toUpperCase() || parsePassageRef(ref ?? "")?.book
  if (book) {
    coords.book = book
    const genre = genreOf(book)
    if (genre) coords.genre = genre
  }

  return coords
}

// ── Resolution ──────────────────────────────────────────────────────────────

export interface EffectiveRule {
  rule: StyleRule
  /** The specificity that decided the rule in — "global" = scope default. */
  via: "global" | ApplicabilityTargetType
  /** True when the decision rests solely on `likely_applies` rows. */
  likely: boolean
}

/** Coordinate value for an exact-match target type, normalized for lookup. */
function coordinateFor(type: ApplicabilityTargetType, coords: CellCoordinates): string | undefined {
  switch (type) {
    case "segment":
      return normalizeTargetId(type, coords.segment)
    case "section":
      return coords.section ? normalizeTargetId(type, coords.section) : undefined
    case "book":
      return coords.book ? normalizeTargetId(type, coords.book) : undefined
    case "file":
      return coords.file ? normalizeTargetId(type, coords.file) : undefined
    case "genre":
      return coords.genre ? normalizeTargetId(type, coords.genre) : undefined
    case "passage":
      return undefined // matched by span overlap, not exact id
  }
}

function matchesAtLevel(
  level: ApplicabilityTargetType,
  entry: RuleIndexEntry,
  coords: CellCoordinates,
  cellSpan: ParsedPassageRef | null,
): RuleApplicability[] {
  if (level === "passage") {
    if (!cellSpan) return []
    return entry.passages.filter((p) => passagesOverlap(p.span, cellSpan)).map((p) => p.row)
  }
  const coordinate = coordinateFor(level, coords)
  if (coordinate === undefined) return []
  const row = entry.exact.get(level)?.get(coordinate)
  return row ? [row] : []
}

/**
 * Resolve the rules in effect for one cell. Output preserves the input rule
 * order; excluded and dormant rules are omitted.
 */
export function resolveEffectiveRules(
  rules: StyleRule[],
  index: ApplicabilityIndex,
  coords: CellCoordinates,
): EffectiveRule[] {
  const cellSpan = coords.passageRef ? parsePassageRef(coords.passageRef) : null
  const effective: EffectiveRule[] = []

  for (const rule of rules) {
    if (rule.status !== "approved" || !rule.enabled) continue

    const entry = index.byRule.get(rule.id)
    let decided = false
    if (entry) {
      for (const level of SPECIFICITY_LADDER) {
        const matched = matchesAtLevel(level, entry, coords, cellSpan)
        if (matched.length === 0) continue
        decided = true
        // Same-specificity tie: any excluded row wins.
        if (!matched.some((row) => row.relationship === "excluded")) {
          effective.push({
            rule,
            via: level,
            likely: !matched.some((row) => row.relationship === "applies"),
          })
        }
        break
      }
    }

    // No matching row anywhere: global rules default in, others lie dormant.
    if (!decided && rule.scope === "global") {
      effective.push({ rule, via: "global", likely: false })
    }
  }

  return effective
}
