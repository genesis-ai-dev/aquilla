// AQU-1679: matching a project's own file to the upstream file it is about to
// follow, line by line.
//
// A link normally brings an upstream file in as a new file. When the project
// already holds the same material — imported on its own, so its cells have
// their own ids — the lead can instead have the link follow INTO that file.
// The upstream's lines then have to be paired with the file's existing lines,
// because the translations hang off the existing cell ids and the mirror only
// knows the upstream's.
//
// The pairing is by content and position, never by id (there is no shared id):
//
//   - lines with identical text pair up, anchored on text that occurs exactly
//     once on each side so a repeated line ("Selah", a blank spacer) cannot
//     drag the alignment sideways;
//   - between two anchors, a run of the same length on both sides is the same
//     lines edited in place, and pairs up position by position;
//   - a run that is longer on one side is an insertion or a removal. Those
//     lines pair with nothing: the upstream's arrive as new lines, the file's
//     own stay as they are. Nothing is ever guessed across such a run.
//
// Pure, and shared by both workers: auth-worker runs it to say what a replace
// will do before the link is made (and to refuse one that makes no sense),
// sync-worker runs it to do it.

/** A source line reduced to what matching needs, in document order. */
export interface MatchLine {
  cellId: string
  value: string
}

export interface LinkFileMatchPair {
  upstreamCellId: string
  /** The project's own cell that stands in for it. */
  cellId: string
  /** The two lines hold exactly the same text. */
  same: boolean
}

export interface LinkFileMatchSummary {
  upstreamLines: number
  localLines: number
  /** Paired, text identical. */
  same: number
  /** Paired by position, text differs: the upstream's text replaces it. */
  changed: number
  /** Upstream lines with no counterpart: they are added to the file. */
  added: number
  /** The file's own lines with no counterpart: they stay as they are. */
  kept: number
  /**
   * Whether the two files are the same material. See {@link canReplaceWith}.
   */
  canReplace: boolean
}

export interface LinkFileMatch extends LinkFileMatchSummary {
  /** In the upstream's order. */
  pairs: LinkFileMatchPair[]
}

/**
 * A replace is offered only when at least half of the longer file's lines are
 * word-for-word the same. Below that the two files are not one piece of
 * material imported twice — they share a name, or a structure — and writing
 * one's source over the other would flag most of the team's translations as
 * out of date against text they were never made from.
 */
export function canReplaceWith(same: number, upstreamLines: number, localLines: number): boolean {
  const longer = Math.max(upstreamLines, localLines)
  return longer > 0 && same > 0 && same * 2 >= longer
}

/**
 * Whitespace is reflowed by importers without the text meaning anything
 * different, so alignment ignores it. Whether a pair counts as `same` does
 * not: that is a promise that nothing about the line changes.
 */
function alignmentKey(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** Indices into `candidates` forming a longest run that rises in `local`. */
function longestRisingRun(candidates: readonly { local: number }[]): number[] {
  const tails: number[] = [] // candidate index ending the best run of each length
  const previous = new Array<number>(candidates.length).fill(-1)
  for (let i = 0; i < candidates.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (candidates[tails[mid]].local < candidates[i].local) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[i] = tails[lo - 1]
    tails[lo] = i
  }
  const run: number[] = []
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) run.push(i)
  return run.reverse()
}

export function matchLinkedFileLines(
  upstream: readonly MatchLine[],
  local: readonly MatchLine[],
): LinkFileMatch {
  const upstreamKeys = upstream.map((line) => alignmentKey(line.value))
  const localKeys = local.map((line) => alignmentKey(line.value))
  // upstream index → local index, -1 = unpaired.
  const localOf = new Array<number>(upstream.length).fill(-1)

  // Half-open ranges still to align. A stack rather than recursion: a file is
  // tens of thousands of lines and the ranges nest.
  const ranges: Array<[number, number, number, number]> = [[0, upstream.length, 0, local.length]]
  while (ranges.length > 0) {
    let [u0, u1, l0, l1] = ranges.pop()!
    while (u0 < u1 && l0 < l1 && upstreamKeys[u0] === localKeys[l0]) localOf[u0++] = l0++
    while (u1 > u0 && l1 > l0 && upstreamKeys[u1 - 1] === localKeys[l1 - 1]) localOf[--u1] = --l1
    if (u0 === u1 || l0 === l1) continue

    // Text that occurs exactly once on each side of this range. Blank lines
    // carry no evidence of where they belong and are never anchors.
    const seen = new Map<string, { upstream: number; local: number; upstreamCount: number; localCount: number }>()
    for (let i = u0; i < u1; i++) {
      const key = upstreamKeys[i]
      if (!key) continue
      const entry = seen.get(key)
      if (entry) entry.upstreamCount++
      else seen.set(key, { upstream: i, local: -1, upstreamCount: 1, localCount: 0 })
    }
    for (let j = l0; j < l1; j++) {
      const entry = seen.get(localKeys[j])
      if (!entry) continue
      entry.localCount++
      entry.local = j
    }
    const candidates = [...seen.values()]
      .filter((entry) => entry.upstreamCount === 1 && entry.localCount === 1)
      .sort((a, b) => a.upstream - b.upstream)
    const anchors = longestRisingRun(candidates).map((index) => candidates[index])

    if (anchors.length === 0) {
      // Nothing in this run reads the same on both sides. The same number of
      // lines is the same lines, edited; any other count is an insertion or a
      // removal, and pairing across it would be a guess.
      if (u1 - u0 === l1 - l0) {
        for (let i = 0; i < u1 - u0; i++) localOf[u0 + i] = l0 + i
      }
      continue
    }
    let uStart = u0
    let lStart = l0
    for (const anchor of anchors) {
      localOf[anchor.upstream] = anchor.local
      ranges.push([uStart, anchor.upstream, lStart, anchor.local])
      uStart = anchor.upstream + 1
      lStart = anchor.local + 1
    }
    ranges.push([uStart, u1, lStart, l1])
  }

  const pairs: LinkFileMatchPair[] = []
  let same = 0
  for (let i = 0; i < upstream.length; i++) {
    const j = localOf[i]
    if (j < 0) continue
    const identical = upstream[i].value === local[j].value
    if (identical) same++
    pairs.push({ upstreamCellId: upstream[i].cellId, cellId: local[j].cellId, same: identical })
  }
  return {
    pairs,
    upstreamLines: upstream.length,
    localLines: local.length,
    same,
    changed: pairs.length - same,
    added: upstream.length - pairs.length,
    kept: local.length - pairs.length,
    canReplace: canReplaceWith(same, upstream.length, local.length),
  }
}

export function summarizeLinkFileMatch(match: LinkFileMatch): LinkFileMatchSummary {
  const { upstreamLines, localLines, same, changed, added, kept, canReplace } = match
  return { upstreamLines, localLines, same, changed, added, kept, canReplace }
}

/**
 * Put a file's source cells back into document order.
 *
 * The projection stores the order as an anchor chain (`anchorCellId` points at
 * the preceding cell; the first cell anchors on null), so row order carries no
 * meaning and matching is entirely about neighbours.
 *
 * Defensive about drift: a chain that forks, cycles, or leaves cells
 * unreachable still yields every input cell exactly once — unreachable cells
 * are appended in input order rather than dropped.
 */
export function orderCellsByAnchor<T extends { cellId: string; anchorCellId?: string | null }>(
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

/** The slice of AquillaDb the reader below needs — both workers' handles fit. */
interface LinesDb {
  prepare(sql: string): {
    bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> }
  }
}

export interface FileSourceLine extends MatchLine {
  anchorCellId: string | null
}

/**
 * A file's live source lines in document order.
 *
 * A tombstoned row is a line the project's own upstream deleted: it is not part
 * of the file any more, and pairing a live line with it would bring it back.
 * Rows are read in `event_id` order so that a forked anchor chain resolves the
 * same way on every read (see {@link orderCellsByAnchor}).
 */
export async function loadFileSourceLines(
  db: LinesDb,
  projectId: string,
  fileId: string,
): Promise<FileSourceLine[]> {
  const { results } = await db
    .prepare(
      `SELECT cell_id, value, anchor_cell_id
         FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'source' AND tombstoned_at IS NULL
        ORDER BY event_id`,
    )
    .bind(projectId, fileId)
    .all<{ cell_id: string; value: string | null; anchor_cell_id: string | null }>()
  return orderCellsByAnchor(
    (results ?? []).map((row) => ({
      cellId: row.cell_id,
      value: row.value ?? "",
      anchorCellId: row.anchor_cell_id,
    })),
  )
}
