// Content-based ICE / 100% matching for source re-import (AQU-1394).
//
// `planImportReconciliation` pairs a re-imported unit to its existing cell by
// *identity* — the parser's unit key, the cell id, or a canonical scripture
// ref. That is exact and cheap, but it only holds while the parser keeps
// minting the same key for the same content. When a client sends v2 of a
// document with a paragraph inserted at the top, index-derived unit keys all
// shift, every unit looks new, and the translations sitting on the old cells
// are stranded even though the source text is untouched.
//
// This module is the content fallback the TMS world calls context matching:
//
//   ICE ("101%")  — the unit's source is identical to an existing unit's AND
//                   the units either side of it are identical too. Nothing
//                   about how this segment reads has changed, so its old
//                   translation is still in context and still correct.
//   exact ("100%") — the source is identical but its neighbours are not. The
//                   translation carries over, but a reviewer may want to look
//                   at it again because the surrounding text moved.
//
// Adoption is narrow by design. A *locked* pair — one identity matching made
// where the source text is byte-for-byte unchanged — is never re-decided; the
// parser's own identity is the best evidence there is. Everything else is
// fair game, including a unit-key pair whose text changed, because an
// index-derived key that now points at different text is precisely the failure
// this module exists to undo. A cell is consumed at most once, so duplicated
// segments pair up first-come-first-served in document order rather than
// collapsing onto one another.

/** A source unit reduced to what content matching cares about. */
export interface ContentMatchCell {
  cellId: string
  value: string
}

/** Per-unit outcome of comparing v2's source text against v1's. */
export type MatchBand = 'ice' | 'exact' | 'changed' | 'new'

export type ContentMatchQuality = Extract<MatchBand, 'ice' | 'exact'>

export interface ContentMatchOutcome {
  /** Incoming cellId → the existing cellId it should adopt, on content alone. */
  adopted: Map<string, { cellId: string; quality: ContentMatchQuality }>
}

/** Sentinels for "nothing before the first unit" / "nothing after the last". */
const START_OF_FILE = '\u0000start'
const END_OF_FILE = '\u0000end'
const FIELD = '\u0001'

/**
 * Collapse runs of whitespace and trim. Case is deliberately preserved: an
 * exact match is a claim that the old translation still applies verbatim, and
 * a case change is a content change in most languages. Whitespace, by
 * contrast, is routinely reflowed by the producing tool without the text
 * meaning anything different.
 */
export function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Put existing source cells back into document order.
 *
 * The projection stores the order as an anchor chain (`anchorCellId` points at
 * the preceding cell; the first cell anchors on null), and the re-import route
 * reads the `cells` rows without an ORDER BY, so row order carries no meaning.
 * Context matching is entirely about neighbours, so the chain has to be walked
 * before anything else happens.
 *
 * Defensive about drift: a chain that forks, cycles, or leaves cells
 * unreachable still yields every input cell exactly once — unreachable cells
 * are appended in input order rather than dropped.
 */
export function orderSourceCellsByAnchor<T extends { cellId: string; anchorCellId?: string | null }>(
  cells: readonly T[],
): T[] {
  const present = new Set(cells.map((cell) => cell.cellId))
  const followers = new Map<string, T[]>()
  const heads: T[] = []
  for (const cell of cells) {
    const anchor = cell.anchorCellId
    if (!anchor || !present.has(anchor) || anchor === cell.cellId) {
      heads.push(cell)
      continue
    }
    const bucket = followers.get(anchor)
    if (bucket) bucket.push(cell)
    else followers.set(anchor, [cell])
  }

  const ordered: T[] = []
  const visited = new Set<string>()
  const walk = (start: T): void => {
    let current: T | undefined = start
    while (current && !visited.has(current.cellId)) {
      visited.add(current.cellId)
      ordered.push(current)
      const next: T[] = followers.get(current.cellId) ?? []
      // A fork is drift, not a chain: take the first follower and let the rest
      // be picked up as their own runs below.
      current = next[0]
      for (const sibling of next.slice(1)) heads.push(sibling)
    }
  }
  for (let i = 0; i < heads.length; i++) walk(heads[i])
  for (const cell of cells) {
    if (!visited.has(cell.cellId)) {
      visited.add(cell.cellId)
      ordered.push(cell)
    }
  }
  return ordered
}

interface Normalized {
  cellId: string
  value: string
  contextKey: string
}

function normalizeSequence(cells: readonly ContentMatchCell[]): Normalized[] {
  const values = cells.map((cell) => normalizeForMatch(cell.value))
  return cells.map((cell, index) => ({
    cellId: cell.cellId,
    value: values[index],
    contextKey: `${index === 0 ? START_OF_FILE : values[index - 1]}${FIELD}${values[index]}${FIELD}${
      index === values.length - 1 ? END_OF_FILE : values[index + 1]
    }`,
  }))
}

/**
 * FIFO buckets keyed by `keyOf`, so duplicates are consumed in document order.
 * Each bucket carries its own cursor rather than being shifted: a file with
 * thousands of repetitions of one line would otherwise make consumption
 * quadratic, and re-import is capped at 50k cells.
 */
interface Bucket {
  items: Normalized[]
  next: number
}

function bucketBy(items: readonly Normalized[], keyOf: (item: Normalized) => string): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>()
  for (const item of items) {
    // A blank unit carries no evidence that a translation still applies, and
    // blank runs are common (spacer paragraphs); never match on one.
    if (!item.value) continue
    const key = keyOf(item)
    const bucket = buckets.get(key)
    if (bucket) bucket.items.push(item)
    else buckets.set(key, { items: [item], next: 0 })
  }
  return buckets
}

function takeUnused(bucket: Bucket | undefined, used: ReadonlySet<string>): Normalized | undefined {
  if (!bucket) return undefined
  while (bucket.next < bucket.items.length && used.has(bucket.items[bucket.next].cellId)) bucket.next++
  return bucket.next < bucket.items.length ? bucket.items[bucket.next++] : undefined
}

/**
 * Decide which incoming units should adopt an existing cell on content alone.
 *
 * `lockedExistingByIncoming` holds the pairs identity matching made where the
 * source text did not change. Those existing cells are off the table and those
 * incoming units are not offered a content match. Every other existing cell is
 * available, so a unit-key pair that now straddles different text can be
 * reclaimed by the unit whose text actually matches.
 */
export function matchImportContent(
  incoming: readonly ContentMatchCell[],
  existing: readonly ContentMatchCell[],
  lockedExistingByIncoming: ReadonlyMap<string, string>,
): ContentMatchOutcome {
  const incomingUnits = normalizeSequence(incoming)
  const existingUnits = normalizeSequence(existing)

  const used = new Set<string>(lockedExistingByIncoming.values())
  const iceBuckets = bucketBy(existingUnits, (unit) => unit.contextKey)
  const exactBuckets = bucketBy(existingUnits, (unit) => unit.value)

  const adopted = new Map<string, { cellId: string; quality: ContentMatchQuality }>()
  // ICE first across the whole file, so a context-perfect pair is never
  // consumed by a merely-exact one that happened to come earlier.
  for (const unit of incomingUnits) {
    if (lockedExistingByIncoming.has(unit.cellId) || !unit.value) continue
    const candidate = takeUnused(iceBuckets.get(unit.contextKey), used)
    if (!candidate) continue
    used.add(candidate.cellId)
    adopted.set(unit.cellId, { cellId: candidate.cellId, quality: 'ice' })
  }
  for (const unit of incomingUnits) {
    if (lockedExistingByIncoming.has(unit.cellId) || adopted.has(unit.cellId) || !unit.value) continue
    const candidate = takeUnused(exactBuckets.get(unit.value), used)
    if (!candidate) continue
    used.add(candidate.cellId)
    adopted.set(unit.cellId, { cellId: candidate.cellId, quality: 'exact' })
  }

  return { adopted }
}

/**
 * Label every incoming unit against the previous version, given the pairing
 * the planner finally settled on (identity, content, or nothing). This is what
 * the import summary counts and what a reviewer reads as "101% / 100% /
 * changed / new".
 */
export function classifyMatchBands(
  incoming: readonly ContentMatchCell[],
  existing: readonly ContentMatchCell[],
  pairedExistingByIncoming: ReadonlyMap<string, string>,
): Map<string, MatchBand> {
  const incomingUnits = normalizeSequence(incoming)
  const existingByCellId = new Map(normalizeSequence(existing).map((unit) => [unit.cellId, unit]))

  const bands = new Map<string, MatchBand>()
  for (const unit of incomingUnits) {
    const counterpartId = pairedExistingByIncoming.get(unit.cellId)
    const counterpart = counterpartId ? existingByCellId.get(counterpartId) : undefined
    if (!counterpart) {
      bands.set(unit.cellId, 'new')
      continue
    }
    if (counterpart.value !== unit.value) {
      bands.set(unit.cellId, 'changed')
      continue
    }
    bands.set(unit.cellId, counterpart.contextKey === unit.contextKey ? 'ice' : 'exact')
  }
  return bands
}
