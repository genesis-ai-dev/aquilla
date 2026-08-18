// Re-importing an episode's audio VTT against the cues already there.
// (AQU-646 stage 4, 2026-08-14)
//
// WHY THIS REPLACED "REPLACE". Replacing used to mint a NEW sibling file, and
// that is ruinous once anyone has recorded: takes are keyed by (project, file,
// cell) and their bytes are stored under `/audio/{project}/{file}/{audio}`, so
// a new file id strands every recording AND requires copying every object; and
// links point at cue CELL ids, so all of them are orphaned too. The original
// plan was to match old cues to new ones and copy everything across. Checking
// the cost made a better answer obvious: don't move anything.
//
// So the file stays, and its cells are reconciled against the incoming list.
// A cue that survives keeps its cell id, which means **its takes and its
// subtitle pairings simply remain attached** — nothing is copied, nothing is
// re-derived, and the failure mode where a performance lands on a different
// line cannot arise for it at all. Only genuinely new cues are created and
// genuinely departed ones deleted.
//
// A pure retime is this operation with no creates and no deletes, which is why
// there is one planner and not two.
//
// MATCHING IS AN ORDER-PRESERVING ALIGNMENT ON NORMALISED WORDING, WITH TIME
// AS A TIEBREAK AND NEVER AS A VETO. Three things had to be true at once, and
// the shape is what falls out of them:
//
//   - Identical wording is required. A reworded cue becomes a delete plus a
//     create, so a performance recorded against the old words is never quietly
//     re-pointed at new ones.
//   - Order must be preserved. An episode carries dozens of bare "Yes." lines,
//     and any index or nearest-in-time scheme eventually pairs the fifth with
//     the first.
//   - Time may only break ties. The plan of record required the timings to
//     OVERLAP; that was wrong and I dropped it while building, because the
//     likeliest reason to re-import is a frame-rate correction shifting cues by
//     up to three seconds — precisely when a short cue's new window clears its
//     old one — so a veto would orphan takes in the one case this exists for.
//
// Length-first LCS satisfied the first two and failed the third in the other
// direction: with three "Yes." and two surviving, every 2-of-3 alignment is
// equally long, and taking the earliest matched a 0:50 cue to a 1:30 one. See
// `alignPairs` for how a sub-1 proximity bonus fixes that without ever letting
// time refuse a pairing.

import { sequenceBetween } from "@/lib/timeline/derive"
import type { TranslatableString } from "@/lib/parsers/types"

/** What an existing cue must carry. `CellData` satisfies it. */
export interface ReconcilableCue {
  id: string
  startTime?: number
  endTime?: number
  original?: string
  /** The cell's current source `event_id` — `source.cell.delete` is
   *  chain-mutating and needs it as `parentId`. */
  sourceEventId?: string
  sequenceIndex?: number
}

export interface CueRetimeMove {
  cellId: string
  startMs: number
  endMs: number
}

export interface CueCreate {
  cellId: string
  /** The cue that precedes it in the FINAL time order, or null at the head. */
  anchorCellId: string | null
  value: string
  startMs: number
  endMs: number
  sequenceIndex: number
}

export interface CueDelete {
  cellId: string
  /** Null when the cell's chain head is unknown; the caller must skip it
   *  rather than send a delete that cannot be arbitrated. */
  sourceEventId: string | null
  /** A recording sits on this cue and will be left unreachable. Counted so the
   *  confirmation can say so BEFORE anything is written. */
  hasTake: boolean
}

export interface CueReconcilePlan {
  /** Only cues whose timings actually change — ~550 an episode, one event
   *  each, so re-stating the unchanged ones would treble the traffic. */
  retimes: CueRetimeMove[]
  creates: CueCreate[]
  deletes: CueDelete[]
  /** Cues in the incoming file. */
  total: number
  /** Survivors — the cues keeping their id, their takes and their pairings. */
  kept: number
  /** Recordings that survive because their cue does. */
  keptTakes: number
  /** Recordings whose cue is going away. The number that decides whether to
   *  go through with it. */
  orphanedTakes: number
  /** Largest timing shift among survivors, seconds. */
  maxShiftSec: number
}

/** Wording only. Case, punctuation, markup and spacing are presentation; a
 *  file differing only in those is the same cue. */
export function normalizeCueText(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const toMs = (sec: number): number => Math.round(sec * 1000)

/** The most a time-proximity tiebreak may be worth. Strictly below 1 — the
 *  score of a match — so gaining an extra match always beats moving an
 *  existing one closer, and the alignment stays LCS-optimal in length. */
const PROXIMITY_WEIGHT = 0.5

/**
 * Order-preserving alignment of two cue lists on identical wording, with time
 * proximity as the tiebreak.
 *
 * PLAIN LCS IS NOT ENOUGH, and a test caught it: an episode carries dozens of
 * bare "Yes." / "No." lines, and when three exist and two survive, every
 * 2-of-3 alignment is an equally long common subsequence. Plain LCS took the
 * earliest, which matched a cue at 0:50 to one at 1:30 and would have carried
 * that take onto a line nobody recorded it for — the precise mis-attribution
 * this operation is supposed to make impossible.
 *
 * So a match is worth 1 plus a fraction that grows as the two cues' starts get
 * closer. The fraction can never reach 1, so the alignment still maximises the
 * number of matches first and only then prefers the near-in-time reading. Time
 * therefore breaks ties without ever being able to REFUSE a match — which is
 * what keeps a 2.4s frame-rate drift from orphaning anything.
 *
 * Typed arrays and a plain O(n·m) table: 550×550 is 300k cells, a few
 * milliseconds, once, at import.
 */
export function alignPairs(
  a: readonly string[],
  b: readonly string[],
  aStartMs: readonly number[],
  bStartMs: readonly number[],
): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = new Float64Array((n + 1) * width)
  const at = (i: number, j: number) => table[i * width + j]
  const matchScore = (i: number, j: number) =>
    1 + PROXIMITY_WEIGHT / (1 + Math.abs(aStartMs[i] - bStartMs[j]) / 1000)

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skip = Math.max(at(i + 1, j), at(i, j + 1))
      table[i * width + j] =
        a[i] === b[j] ? Math.max(matchScore(i, j) + at(i + 1, j + 1), skip) : skip
    }
  }

  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j] && matchScore(i, j) + at(i + 1, j + 1) >= Math.max(at(i + 1, j), at(i, j + 1))) {
      pairs.push([i, j])
      i++
      j++
    } else if (at(i + 1, j) >= at(i, j + 1)) i++
    else j++
  }
  return pairs
}

export interface PlanCueReconcileArgs {
  existing: readonly ReconcilableCue[]
  incoming: readonly TranslatableString[]
  /** Does this cue carry a recording? Drives the orphan count only. */
  hasTake?: (cellId: string) => boolean
  /** Mints a cell id for a newly arrived cue. Injected so the planner stays
   *  pure and tests can make ids predictable. */
  mintId: () => string
}

/**
 * Work out what turning `existing` into `incoming` costs. Pure; no I/O, no
 * events. Null when there is nothing to reconcile against — a first import.
 */
export function planCueReconcile({
  existing,
  incoming,
  hasTake,
  mintId,
}: PlanCueReconcileArgs): CueReconcilePlan | null {
  if (existing.length === 0) return null

  // Incoming cues with no usable timing cannot be placed; dropping them here
  // beats filing them at the head of the film.
  const timedIncoming = incoming.filter(
    (c): c is TranslatableString & { start: number; end: number } =>
      typeof c.start === "number" &&
      typeof c.end === "number" &&
      Number.isFinite(c.start) &&
      Number.isFinite(c.end),
  )
  if (timedIncoming.length === 0) return null

  const oldText = existing.map((c) => normalizeCueText(c.original ?? ""))
  const newText = timedIncoming.map((c) => normalizeCueText(c.original ?? ""))
  const pairs = alignPairs(
    oldText,
    newText,
    // A cue with no timing of its own sits at zero for tiebreak purposes only;
    // it can still match, it just contributes no proximity evidence.
    existing.map((c) => (typeof c.startTime === "number" ? toMs(c.startTime) : 0)),
    timedIncoming.map((c) => toMs(c.start)),
  )

  const matchedOld = new Set<number>()
  const matchedNew = new Set<number>()
  const retimes: CueRetimeMove[] = []
  let maxShiftSec = 0
  let keptTakes = 0

  for (const [oi, ni] of pairs) {
    matchedOld.add(oi)
    matchedNew.add(ni)
    const was = existing[oi]
    const now = timedIncoming[ni]
    if (hasTake?.(was.id)) keptTakes++
    const startMs = toMs(now.start)
    const endMs = toMs(now.end)
    const wasStartMs = typeof was.startTime === "number" ? toMs(was.startTime) : null
    const wasEndMs = typeof was.endTime === "number" ? toMs(was.endTime) : null
    if (wasStartMs === startMs && wasEndMs === endMs) continue
    retimes.push({ cellId: was.id, startMs, endMs })
    if (wasStartMs !== null) {
      maxShiftSec = Math.max(maxShiftSec, Math.abs(startMs - wasStartMs) / 1000)
    }
  }

  const deletes: CueDelete[] = []
  let orphanedTakes = 0
  for (let i = 0; i < existing.length; i++) {
    if (matchedOld.has(i)) continue
    const has = hasTake?.(existing[i].id) ?? false
    if (has) orphanedTakes++
    deletes.push({
      cellId: existing[i].id,
      sourceEventId: existing[i].sourceEventId ?? null,
      hasTake: has,
    })
  }

  // Creates are anchored against the FINAL order, so the chain the cells read
  // walks stays coherent. Survivors carry their new timings here, not their old
  // ones — otherwise a big shift would anchor a new cue to the wrong neighbour.
  const finalOrder: Array<
    | { kind: "kept"; cellId: string; startMs: number; seq?: number }
    | { kind: "new"; ni: number; startMs: number }
  > = []
  const newTimesForOld = new Map<number, { startMs: number }>()
  for (const [oi, ni] of pairs) {
    newTimesForOld.set(oi, { startMs: toMs(timedIncoming[ni].start) })
  }
  for (let i = 0; i < existing.length; i++) {
    if (!matchedOld.has(i)) continue
    finalOrder.push({
      kind: "kept",
      cellId: existing[i].id,
      startMs: newTimesForOld.get(i)!.startMs,
      seq: existing[i].sequenceIndex,
    })
  }
  for (let j = 0; j < timedIncoming.length; j++) {
    if (matchedNew.has(j)) continue
    finalOrder.push({ kind: "new", ni: j, startMs: toMs(timedIncoming[j].start) })
  }
  finalOrder.sort((a, b) => a.startMs - b.startMs)

  const creates: CueCreate[] = []
  const idFor = new Map<number, string>()
  for (let k = 0; k < finalOrder.length; k++) {
    const entry = finalOrder[k]
    if (entry.kind !== "new") continue
    const prev = finalOrder[k - 1]
    const next = finalOrder[k + 1]
    const cellId = idFor.get(entry.ni) ?? mintId()
    idFor.set(entry.ni, cellId)
    const cue = timedIncoming[entry.ni]
    creates.push({
      cellId,
      anchorCellId:
        prev == null
          ? null
          : prev.kind === "kept"
            ? prev.cellId
            : (idFor.get(prev.ni) ?? null),
      value: cue.original ?? "",
      startMs: toMs(cue.start),
      endMs: toMs(cue.end),
      sequenceIndex: sequenceBetween(
        prev?.kind === "kept" ? prev.seq : undefined,
        next?.kind === "kept" ? next.seq : undefined,
      ),
    })
  }

  return {
    retimes,
    creates,
    deletes,
    total: timedIncoming.length,
    kept: pairs.length,
    keptTakes,
    orphanedTakes,
    maxShiftSec,
  }
}
