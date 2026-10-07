/**
 * Discovered forms — the distinct surface strings a concept's matcher actually
 * hits in a set of cells. Derived on read; no persistence. Callers pass the
 * cells they already hold (term page: project cells; editor popover: the open
 * file's cells).
 */

import type { Concept, TermMatchingSettings } from "./types"
import { findConceptMatches, stripMarks } from "./match"
import { resolveMatchOptions } from "./match-options"

export interface DiscoveredForm {
  surface: string
  count: number
  excluded: boolean
  sampleCellIds: string[]
}

type ConceptLike = Pick<Concept, "sourceTerm" | "match"> & { caseSensitive?: boolean }
type CellLike = { id: string; original: string }

/** Comparison key for a surface form under the concept's options. */
export function formKey(surface: string, foldMarks: boolean, caseSensitive: boolean): string {
  const folded = foldMarks ? stripMarks(surface) : surface.normalize("NFC")
  return caseSensitive ? folded : folded.toLowerCase()
}

export interface ConceptPreview {
  forms: DiscoveredForm[]
  /** Cells with at least one live (non-excluded) match. */
  cellCount: number
}

/**
 * Forms AND the live cell count from ONE scan of the cells (AQU-1272).
 *
 * `discoverForms` and `countConceptOccurrences` each walked every cell, so a
 * caller that shows both — the add-concept preview, which recomputes per
 * keystroke — paid for the corpus twice. The scan already knows which cells had
 * a live match, so the count is free here.
 */
export function previewConceptMatches(
  cells: ReadonlyArray<CellLike>,
  concept: ConceptLike,
  project?: TermMatchingSettings,
  opts: { maxSamples?: number } = {},
): ConceptPreview {
  const maxSamples = opts.maxSamples ?? 3
  const r = resolveMatchOptions(concept, project)
  const caseSensitive = concept.caseSensitive === true
  const excludedKeys = new Set(r.excludedForms.map((f) => formKey(f, r.foldMarks, caseSensitive)))
  const byNfc = new Map<string, DiscoveredForm>()
  let cellCount = 0

  for (const cell of cells) {
    let liveInCell = false
    for (const m of findConceptMatches(cell.original, concept, project, { includeExcluded: true })) {
      const surface = m.surface.normalize("NFC")
      let entry = byNfc.get(surface)
      if (!entry) {
        entry = {
          surface,
          count: 0,
          excluded: excludedKeys.has(formKey(surface, r.foldMarks, caseSensitive)),
          sampleCellIds: [],
        }
        byNfc.set(surface, entry)
      }
      entry.count += 1
      if (!entry.excluded) liveInCell = true
      if (entry.sampleCellIds.length < maxSamples && !entry.sampleCellIds.includes(cell.id)) {
        entry.sampleCellIds.push(cell.id)
      }
    }
    if (liveInCell) cellCount += 1
  }

  return {
    forms: [...byNfc.values()].sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface)),
    cellCount,
  }
}

export function discoverForms(
  cells: ReadonlyArray<CellLike>,
  concept: ConceptLike,
  project?: TermMatchingSettings,
  opts: { maxSamples?: number } = {},
): DiscoveredForm[] {
  return previewConceptMatches(cells, concept, project, opts).forms
}

/** Cells with at least one live (non-excluded) match. */
export function countConceptOccurrences(
  cells: ReadonlyArray<CellLike>,
  concept: ConceptLike,
  project?: TermMatchingSettings,
): number {
  let n = 0
  for (const cell of cells) {
    if (findConceptMatches(cell.original, concept, project).length > 0) n += 1
  }
  return n
}
