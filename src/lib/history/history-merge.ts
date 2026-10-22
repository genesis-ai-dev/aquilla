/**
 * Merging two copies of one person's history. (Decision 11: the history
 * follows the person between computers and browsers.)
 *
 * The same history can live in several places at once: this browser's saved
 * copy, the server's copy, and another device's copy that reached the server
 * first. None of them is "the" history, so they are merged STEP BY STEP, by id:
 *
 * - Every step knows when it last moved between Undo and Redo (`movedAt`). The
 *   copy that moved it most recently says where it is now.
 * - A step that left both stacks (its undo was skipped, its action was refused,
 *   or a newer step cleared it from Redo) is remembered by id in `gone`, so a
 *   copy that still holds it cannot bring it back.
 * - Redo only ever holds steps undone AFTER the newest step was made. A step
 *   undone on one device before another device made a new step can no longer
 *   be redone, exactly as a new step clears Redo on one device.
 *
 * Pure and order-independent apart from ties (the first copy wins those), so
 * two devices merging each other's copies reach the same history.
 */
import type { SkipLogEntry, StepRecord } from "./history"

export interface GoneEntry {
  id: string
  /** When it left (ms). */
  at: number
}

/** A history as it is saved and sent: both stacks, the skip log, the tombstones. */
export interface HistoryDoc {
  undo: StepRecord[]
  redo: StepRecord[]
  log: SkipLogEntry[]
  gone: GoneEntry[]
}

/** Enough to outlive any copy that could still hold the steps. */
export const GONE_LIMIT = 400

export const emptyHistoryDoc = (): HistoryDoc => ({ undo: [], redo: [], log: [], gone: [] })

const movedAt = (r: StepRecord) => r.movedAt ?? r.at
const byAtThenId = (a: StepRecord, b: StepRecord) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Read a saved or sent history defensively: anything malformed is left out. */
export function normalizeHistoryDoc(raw: unknown): HistoryDoc {
  const v = (raw ?? {}) as Partial<Record<keyof HistoryDoc, unknown>>
  const steps = (x: unknown) =>
    Array.isArray(x)
      ? (x as StepRecord[]).filter((r) => r && typeof r.id === "string" && typeof r.kind === "string" && typeof r.at === "number")
      : []
  return {
    undo: steps(v.undo),
    redo: steps(v.redo),
    log: Array.isArray(v.log) ? (v.log as SkipLogEntry[]).filter((e) => e && typeof e.id === "string") : [],
    gone: Array.isArray(v.gone)
      ? (v.gone as GoneEntry[]).filter((g) => g && typeof g.id === "string" && typeof g.at === "number")
      : [],
  }
}

export function mergeHistories(
  a: HistoryDoc,
  b: HistoryDoc,
  limits: { steps: number; log: number },
): HistoryDoc {
  const gone = new Map<string, number>()
  const bury = (id: string, at: number) => gone.set(id, Math.max(gone.get(id) ?? 0, at))
  for (const g of [...a.gone, ...b.gone]) bury(g.id, g.at)

  const chosen = new Map<string, { record: StepRecord; stack: "undo" | "redo" }>()
  const offer = (record: StepRecord, stack: "undo" | "redo") => {
    if (gone.has(record.id)) return
    const prev = chosen.get(record.id)
    if (!prev || movedAt(record) > movedAt(prev.record)) chosen.set(record.id, { record, stack })
  }
  for (const doc of [a, b]) {
    for (const r of doc.undo) offer(r, "undo")
    for (const r of doc.redo) offer(r, "redo")
  }

  const picks = [...chosen.values()]
  let undo = picks.filter((p) => p.stack === "undo").map((p) => p.record).sort(byAtThenId)
  const newestMade = undo.reduce((m, r) => Math.max(m, r.at), Number.NEGATIVE_INFINITY)
  const redo: StepRecord[] = []
  for (const { record, stack } of picks) {
    if (stack !== "redo") continue
    if (movedAt(record) < newestMade) bury(record.id, newestMade)
    else redo.push(record)
  }
  // The next step to redo sits LAST: the one made most recently is redone last.
  redo.sort((x, y) => byAtThenId(y, x))
  if (undo.length > limits.steps) undo = undo.slice(undo.length - limits.steps)

  const seen = new Set<string>()
  const log = [...a.log, ...b.log]
    .filter((e) => {
      const key = `${e.id}\u0000${e.which}\u0000${e.at}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((x, y) => x.at - y.at)
    .slice(-limits.log)

  const goneList = [...gone.entries()]
    .map(([id, at]) => ({ id, at }))
    .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
    .slice(-GONE_LIMIT)

  return { undo, redo, log, gone: goneList }
}

/** Two copies that hold the same steps in the same places (the log aside). */
export function sameHistory(a: HistoryDoc, b: HistoryDoc): boolean {
  const sig = (d: HistoryDoc) =>
    JSON.stringify([
      d.undo.map((r) => [r.id, movedAt(r)]),
      d.redo.map((r) => [r.id, movedAt(r)]),
      d.gone.map((g) => g.id),
      d.log.length,
    ])
  return sig(a) === sig(b)
}
