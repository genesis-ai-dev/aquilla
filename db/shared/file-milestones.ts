/**
 * Hand-set milestones: a named start→end range of cells in one file (AQU-2308).
 *
 * A milestone is its own record — id, name, start anchor, end anchor — not a
 * label on a cell. That is the whole point of the shape: the canceled marker
 * design (AQU-2185) named ONE cell and let the section run to the next marker,
 * which cannot say "lines 50 to 70 are The storm" without also naming whatever
 * follows line 70.
 *
 * Which cells a milestone covers is NOT stored. It is resolved at read time by
 * walking the file's cell order from the start anchor to the end anchor, so a
 * cell inserted inside the range is covered automatically and no stored span
 * has to be kept in step with the file.
 *
 * This module is the shared core: the client derivation (navigator) and the
 * sync-worker handlers (write perimeter) both import it, so the name rule and
 * the overlap rule cannot drift between the dialog and the server. Everything
 * here is pure — no SQL, no DOM, no i18n.
 */

/** A hand-set milestone as stored, and as carried on the wire. */
export interface FileMilestone {
  /** Client-minted, stable for the life of the record. */
  id: string
  /** Shown exactly as typed — content, not UI vocabulary. */
  name: string
  /** First cell of the range, in file order. */
  startCellId: string
  /** Last cell of the range, inclusive. */
  endCellId: string
}

/**
 * Longest name we store. A milestone name is content a person types into a
 * navigator row, not prose; the cap is what keeps one from becoming an
 * unbounded column and an unreadable row.
 */
export const MILESTONE_NAME_MAX_LENGTH = 200

/**
 * Ids are client-minted (a uuid in practice) and become part of a navigator
 * row key, so they are constrained to the same safe alphabet track ids use.
 */
const MILESTONE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isValidMilestoneId(value: unknown): value is string {
  return typeof value === "string" && MILESTONE_ID_PATTERN.test(value)
}

/**
 * The stored form of a typed name, or `null` when it is not storable.
 *
 * Trims, because trailing whitespace in a navigator row is invisible and
 * would make two milestones look identical. Blank or whitespace-only is
 * `null` — refused by the dialog and by the server, which is one rule in one
 * place rather than two that can disagree.
 */
export function normalizeMilestoneName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > MILESTONE_NAME_MAX_LENGTH) return null
  return trimmed
}

/** A milestone whose anchors were both found, with the run it covers. */
export interface ResolvedMilestoneSpan {
  milestone: FileMilestone
  /** Index of the start anchor in the order given. */
  startIndex: number
  /** Index of the end anchor, inclusive. */
  endIndex: number
}

/**
 * Where one milestone's anchors sit in the file's cell order.
 *
 * Returns `null` when either anchor is missing from the order (a cell removed,
 * or a record from another file) or when the end anchor precedes the start.
 * A caller that cannot place a milestone skips it: an unplaceable record must
 * never take the navigator down with it. Anchor survival when a cell is
 * removed or the file is re-imported is its own slice (AQU-2311); until then
 * an orphaned record is simply not shown.
 */
export function placeMilestone(
  order: readonly string[],
  milestone: FileMilestone,
): ResolvedMilestoneSpan | null {
  const startIndex = order.indexOf(milestone.startCellId)
  if (startIndex < 0) return null
  const endIndex = order.indexOf(milestone.endCellId)
  if (endIndex < 0 || endIndex < startIndex) return null
  return { milestone, startIndex, endIndex }
}

/**
 * Every milestone that is both placeable and non-overlapping, in file order.
 *
 * The precedence rule is deliberately the dumbest one that is total: **the
 * milestone that starts first wins, and anything overlapping it is skipped.**
 * Ties on the start index are broken by id so the answer does not depend on
 * the order rows came back from the store.
 *
 * The dialog refuses an overlap before it is ever written, so in normal use
 * nothing is skipped here. This exists because "the navigator never breaks" is
 * the bar: records can reach the store by another route (a replayed event log,
 * a future API, two maintainers racing), and when they do the list must still
 * resolve to one unambiguous set of spans.
 */
export function resolveMilestoneSpans(
  order: readonly string[],
  milestones: readonly FileMilestone[],
): ResolvedMilestoneSpan[] {
  const placed = milestones
    .map((milestone) => placeMilestone(order, milestone))
    .filter((span): span is ResolvedMilestoneSpan => span !== null)
    .sort((a, b) => (
      a.startIndex - b.startIndex
      || (a.milestone.id < b.milestone.id ? -1 : a.milestone.id > b.milestone.id ? 1 : 0)
    ))

  const kept: ResolvedMilestoneSpan[] = []
  let coveredThrough = -1
  for (const span of placed) {
    if (span.startIndex <= coveredThrough) continue
    kept.push(span)
    coveredThrough = span.endIndex
  }
  return kept
}

/** Read a wire/stored record, returning `undefined` for anything malformed. */
export function parseFileMilestone(value: unknown): FileMilestone | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const id = candidate.id
  const name = normalizeMilestoneName(candidate.name)
  const startCellId = candidate.startCellId
  const endCellId = candidate.endCellId
  if (!isValidMilestoneId(id)) return undefined
  if (name === null) return undefined
  if (typeof startCellId !== "string" || !startCellId) return undefined
  if (typeof endCellId !== "string" || !endCellId) return undefined
  return { id, name, startCellId, endCellId }
}
