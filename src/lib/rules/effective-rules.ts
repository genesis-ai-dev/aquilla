/**
 * effective-rules.ts — compose the rule set that lints ONE cell (AQU-934
 * phase 3a).
 *
 * Style-library entries carrying a deterministic `checkSpec` compile to
 * `TranslationRule`s (style-rule-bridge.ts), but a library check must only
 * fire where the applicability graph says the rule is in force — a poetry rule
 * has no business linting an epistle. This module is the join: it builds the
 * applicability index and the compiled-rule map ONCE per library change, then
 * answers "which rules lint this cell" per cell.
 *
 * Pure: no React, no fetch. The caller injects the library, the graph and the
 * cell → coordinates mapping (it owns file metadata, this module does not).
 */
import type { TranslationRule } from "@/lib/parsers/types"

import { buildApplicabilityIndex, resolveEffectiveRules } from "./applicability"
import { compileStyleRulesToTranslationRules, styleRuleIdFromRuleId } from "./style-rule-bridge"
import type { CellCoordinates, RuleApplicability, StyleRule } from "./style-rule-types"

/**
 * `signature` value meaning "no library rule can lint anything". Callers key
 * cache invalidation off the signature, so this doubles as the marker that the
 * resolver contributes nothing at all.
 */
export const NO_LIBRARY_LINT_SIGNATURE = ""

/** The cell fields forwarded to `coordsFor`, plus the file it lives in. */
export interface LintCellRef {
  id: string
  fileId: string
  /** Scripture cells carry the canonicalRef here when globalReferences are absent. */
  group?: string
  globalReferences?: string[]
}

/** What `rulesForCell` needs from a cell — `fileId` arrives as its own arg. */
export type LintCell = Omit<LintCellRef, "fileId">

export interface LibraryLintSource {
  styleRules: StyleRule[]
  applicability: RuleApplicability[]
  /** Cell → coordinates; supplied by the caller (it owns file metadata). */
  coordsFor: (cell: LintCellRef) => CellCoordinates
}

export interface LibraryLintResolver {
  /** Rules to lint this cell with = project rules + applicable library checks. */
  rulesForCell: (
    cell: LintCell,
    fileId: string,
    projectEnabledRules: TranslationRule[],
  ) => TranslationRule[]
  /** Changes iff the library or the graph changed; feeds a memo cache key. */
  signature: string
}

/** Distinct cell coordinates whose resolution is worth remembering. */
const MAX_CACHED_COORDINATES = 512

// Separators no rule id, target id or serialized check can contain.
const FIELD_SEP = "\u0001"
const RECORD_SEP = "\u0002"
const SECTION_SEP = "\u0003"

/**
 * Covers exactly what can change a lint outcome: the compiled rules (id +
 * check) in library order, and the graph rows that address them. Rows are
 * sorted so a reordered server response does not invalidate every cached cell;
 * rules are not, because their order is the order infractions are reported in.
 *
 * A row's surrogate `id` is deliberately excluded — re-upserting a row with an
 * identical target and relationship changes no outcome.
 */
function lintSignature(compiled: TranslationRule[], rows: RuleApplicability[]): string {
  const rulePart = compiled
    .map((rule) => `${rule.id}${FIELD_SEP}${JSON.stringify(rule.check)}`)
    .join(RECORD_SEP)
  const rowPart = rows
    .map((row) => [row.ruleId, row.targetType, row.targetId, row.relationship].join(FIELD_SEP))
    .sort()
    .join(RECORD_SEP)
  return `${rulePart}${SECTION_SEP}${rowPart}`
}

/**
 * Coordinate identity for the resolution cache. Cells in one file share genre,
 * book and file, and a chapter's worth share `section`, so a whole book
 * usually collapses to a handful of distinct resolutions. `passageRef` and
 * `segment` only participate when rows of that specificity exist — otherwise
 * they cannot affect the outcome and would make every cell its own key.
 */
function coordinateKey(
  coords: CellCoordinates,
  withPassage: boolean,
  withSegment: boolean,
): string {
  return [
    coords.genre ?? "",
    coords.book ?? "",
    coords.file ?? "",
    coords.section ?? "",
    withPassage ? coords.passageRef ?? "" : "",
    withSegment ? coords.segment : "",
  ].join(FIELD_SEP)
}

/**
 * Build the per-cell rule composer for one style-rule library + graph.
 *
 * Only `approved` + `enabled` + `checkSpec`-bearing rules participate:
 * instruction-only rules are unenforceable and reach the model through the
 * prompt instead, and an unapproved rule must never lint a translator's work.
 *
 * `likely_applies` counts as applying, exactly as the prompt path treats it
 * (`resolveEffectiveRules` returns those rules, flagged `likely`) — a model's
 * best guess at scope still lints, and the human corrects the graph if it is
 * wrong.
 */
export function buildLibraryLintResolver(source: LibraryLintSource): LibraryLintResolver {
  const lintable = source.styleRules.filter(
    (rule) => rule.status === "approved" && rule.enabled && rule.checkSpec !== null,
  )
  if (lintable.length === 0) {
    return {
      // Identity in = identity out: with nothing to add, callers keep the exact
      // array they passed, so existing reference-equality checks are untouched.
      rulesForCell: (_cell, _fileId, projectEnabledRules) => projectEnabledRules,
      signature: NO_LIBRARY_LINT_SIGNATURE,
    }
  }

  const compiled = compileStyleRulesToTranslationRules(lintable)
  const compiledById = new Map<string, TranslationRule>()
  for (const rule of compiled) {
    const styleRuleId = styleRuleIdFromRuleId(rule.id)
    if (styleRuleId) compiledById.set(styleRuleId, rule)
  }

  // Rows addressing rules that cannot lint (instruction-only, unapproved) are
  // dropped here rather than per cell, and stay out of the signature: they can
  // never change an outcome.
  const rows = source.applicability.filter((row) => compiledById.has(row.ruleId))
  const index = buildApplicabilityIndex(rows)
  const withPassage = rows.some((row) => row.targetType === "passage")
  const withSegment = rows.some((row) => row.targetType === "segment")

  // Keyed by coordinate, not by cell, and holding only the library slice —
  // composing it with the caller's rules is a transient concat, so the cache
  // never grows with the project's rule count. Only segment/passage rows can
  // make keys per-cell; past the bound the cache is dropped rather than left
  // to grow with a whole book (each miss then costs one resolve, which is the
  // uncached cost anyway).
  const byCoordinate = new Map<string, TranslationRule[]>()

  const rulesForCell = (
    cell: LintCell,
    fileId: string,
    projectEnabledRules: TranslationRule[],
  ): TranslationRule[] => {
    const coords = source.coordsFor({
      id: cell.id,
      fileId,
      ...(cell.group !== undefined ? { group: cell.group } : {}),
      ...(cell.globalReferences !== undefined ? { globalReferences: cell.globalReferences } : {}),
    })
    const key = coordinateKey(coords, withPassage, withSegment)
    let applicable = byCoordinate.get(key)
    if (!applicable) {
      applicable = []
      for (const effective of resolveEffectiveRules(lintable, index, coords)) {
        const rule = compiledById.get(effective.rule.id)
        if (rule) applicable.push(rule)
      }
      if (byCoordinate.size >= MAX_CACHED_COORDINATES) byCoordinate.clear()
      byCoordinate.set(key, applicable)
    }
    // Nothing applies → the caller keeps its own array, by reference.
    return applicable.length === 0 ? projectEnabledRules : [...projectEnabledRules, ...applicable]
  }

  return { rulesForCell, signature: lintSignature(compiled, rows) }
}
