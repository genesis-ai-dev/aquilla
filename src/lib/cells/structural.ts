// Which cells are STRUCTURE rather than content. (AQU-1083)
//
// Book titles, chapter markers and section heads: the cells a USFM import types
// `heading` or `paratext`. AQU-610 already used this set to decide which cells
// get a sequential number and which rows speak in the cast gutter, but it was
// written out at each site rather than named — so there were two nearly-equal
// answers to "is this cell structural" and no way to change them together.
//
// The server's copy is sync-worker/src/events/structural-cells.ts. The two must
// agree: the editor's status bar counts cells in memory while every other
// surface reads numbers the server computed, and a disagreement shows up as the
// footer contradicting the sidebar for the same file.

/** Cell types that are structure. Anything else — including nothing — is content. */
export const STRUCTURAL_CELL_TYPES: readonly string[] = ["heading", "paratext"]

/**
 * Is this cell structure rather than translatable content?
 *
 * Null and undefined are CONTENT, not structure. Every media and cue import
 * writes no type at all, so a predicate that treated "unknown" as structural
 * would quietly drop an entire audio project out of its own denominator.
 */
export function isStructuralCell(type: string | null | undefined): boolean {
  return type != null && STRUCTURAL_CELL_TYPES.includes(type)
}

/**
 * Should this cell count toward progress, under the effective policy?
 *
 * `countStructural` is the project's answer, else its org's, else true — which
 * the server resolves and hands to the client. True is today's behaviour and
 * the default everywhere, so a caller that has not yet learned about the
 * setting behaves exactly as it always did.
 */
export function countsTowardProgress(
  type: string | null | undefined,
  countStructural: boolean,
): boolean {
  return countStructural || !isStructuralCell(type)
}

/** The three numbers every progress surface renders. */
interface ProgressTriple {
  total: number
  translated: number
  validated: number
}

/**
 * Apply the policy to a progress triple that was counted over `cells`
 * WITHOUT it.
 *
 * The editor footer reads useHealth's live per-file count, and the health
 * hook knows nothing about cell types. Rather than teach it the policy, the
 * workspace subtracts the structural subset here — by the SAME `status` rule
 * useHealth counts with (non-empty ⇒ translated, "validated" ⇒ validated), so
 * the two can never drift. A heading leaves both halves of the ratio: a
 * translated chapter title must not inflate the numerator for work the policy
 * says nobody has to do.
 */
export function applyStructuralPolicy<T extends ProgressTriple>(
  progress: T,
  cells: ReadonlyArray<{ type: string | null | undefined; status: string }>,
  countStructural: boolean,
): T {
  if (countStructural) return progress
  let total = 0
  let translated = 0
  let validated = 0
  for (const cell of cells) {
    if (!isStructuralCell(cell.type)) continue
    total += 1
    if (cell.status !== "empty") translated += 1
    if (cell.status === "validated") validated += 1
  }
  if (total === 0) return progress
  return {
    ...progress,
    total: progress.total - total,
    translated: progress.translated - translated,
    validated: progress.validated - validated,
  }
}
