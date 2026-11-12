// AQU-1278: the parked-scroll arbitration, out of ProjectWorkspace and into a
// module a test can hold still — the review found the whole state machine
// (who may park over whom, the attempt budget, the file guard) living inline
// in two effects of a ten-thousand-line component, reachable by no test.
//
// THE MACHINE. A "park" is a cell someone wants scrolled to once the editor
// can do it: a `?cellId=` deep link, a remembered last position, or the
// media→text trace. The consumer fires on every cell-store version until the
// scroll lands — and a park must be able to LOSE: an id the file does not
// have would otherwise retry on every committed keystroke for the rest of the
// session, and follow the user into other files, hijacking their scroll the
// moment an unrelated file happened to contain a matching id.
//
// This module decides; the effects in ProjectWorkspace only carry out.

/**
 * How many cell-store versions a park may spend looking for its row before it
 * gives up. More than one because a file's cells stream in — the target can
 * land two or three versions after the store stops being empty — but a
 * ceiling far more, because an id the file simply does not have would
 * otherwise retry forever.
 */
export const PENDING_CELL_SCROLL_MAX_ATTEMPTS = 8

export interface PendingCellScroll {
  cellId: string
  flash: boolean
  /** The file the cell was parked FOR; null means "wherever we are". */
  fileId: string | null
  source: "link" | "restore" | "trace" | "view"
  /**
   * Where the row should land in the viewport. "center" (the default) is what
   * a jump the user is inspecting wants. AQU-2153's view-switch resume needs
   * "top": it is putting back the row that WAS at the top, and centring it
   * would leave the reader half a screen from where they were.
   */
  align?: "center" | "top"
}

/** The consumer's bookkeeping: one park's spent budget and travel history. */
export interface PendingScrollAttempt {
  cellId: string
  /** Were we EVER in the parked file? Departure only counts after arrival. */
  arrived: boolean
  attempts: number
}

/**
 * May the last-location restore park over what is already parked?
 *
 * A `link` is an explicit request from the user and outranks a `restore`,
 * which is only a convenience — and declaration order does NOT settle who
 * wins: the restore effect re-runs whenever its asynchronously-resolving deps
 * settle, routinely several commits after the deep link has parked. Without
 * this rule the remembered position quietly replaced the cell a "go to the
 * first unvalidated cell" link asked for, and the link appeared to land on a
 * random row. (`trace` never races either parker — it fires from a click,
 * long after both — so it needs no rule here.)
 *
 * AQU-2153: a `view` resume is excluded too. It is parked by a lens switch,
 * which does not navigate — so the arrival this effect keys off has not
 * changed, and re-parking the remembered LAST position over it would undo the
 * resume the user just asked for by switching back.
 */
export function restoreMayPark(existing: PendingCellScroll | null): boolean {
  return existing?.source !== "link" && existing?.source !== "view"
}

/**
 * May a view-switch resume (AQU-2153) park over what is already parked?
 *
 * It is the weakest parker in the machine. Every other park is a place
 * someone asked for — a `?cellId=` deep link, a comment thread's "go to
 * cell", the media→text trace, the remembered last position on arrival — and
 * a resume is only where the user happened to be standing. So rather than
 * ranking itself against each source, it yields to anything already waiting.
 */
export function viewMayPark(existing: PendingCellScroll | null): boolean {
  return existing === null
}

export type PendingScrollStep =
  /** The park lost: departed its file, or nothing left to try. */
  | { kind: "give-up" }
  /** In the parked file: scroll. `last` = the budget ends with this try. */
  | { kind: "try"; attempt: PendingScrollAttempt; last: boolean }
  /**
   * Not in the parked file (yet): spend budget but DO NOT scroll — scrolling
   * whatever file is open now is exactly the hijack this machine exists to
   * prevent.
   */
  | { kind: "wait"; attempt: PendingScrollAttempt; last: boolean }

/**
 * One consumer tick. Pure: hand back a fresh attempt record rather than
 * mutating the old one, so a test can diff the two.
 *
 * A park is made BEFORE the navigation that opens its file, so a file
 * mismatch is ambiguous on its own: it means either "the route has not caught
 * up yet" or "the user has moved on". `arrived` tells them apart — only a
 * mismatch AFTER we were once in the parked file is a departure. The budget
 * covers the other case, a file we never reach at all.
 *
 * The budget is keyed by cell id: a FRESH park starts with a full budget
 * without every parker having to remember to reset a counter.
 */
export function stepPendingScroll(
  pending: PendingCellScroll,
  prev: PendingScrollAttempt | null,
  activeFileId: string | null,
): PendingScrollStep {
  const base = prev && prev.cellId === pending.cellId
    ? prev
    : { cellId: pending.cellId, arrived: false, attempts: 0 }
  const onParkedFile = !pending.fileId || pending.fileId === activeFileId
  if (!onParkedFile && base.arrived) return { kind: "give-up" }
  const attempt: PendingScrollAttempt = {
    cellId: base.cellId,
    arrived: base.arrived || onParkedFile,
    attempts: base.attempts + 1,
  }
  const last = attempt.attempts >= PENDING_CELL_SCROLL_MAX_ATTEMPTS
  return onParkedFile ? { kind: "try", attempt, last } : { kind: "wait", attempt, last }
}
