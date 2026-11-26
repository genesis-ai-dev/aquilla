// Which Undo steps are the Station's own (AQU-2327, Q4; Sam, Oct 30: "even in
// the station, it should only apply to the station").
//
// AQU-2493 (review, Nov 9): the Station's Undo button takes back the last
// change to the OPEN RECORDING and nothing else. The rule before matched any
// step that named the line and carried no take id, so a translation edit, a
// text approval, a retime or a hide on the same line lit the button up and
// was taken back from here. Now a step is the Station's only when it is a
// change to a take (trim, volume and fades, rename, a saved or cleaned
// version, a delete) or an approval of one, and it names this take.
//
// A move is not: it changes where the take sits on the timeline, which the
// Station has no control for, not the recording open in it. Its Undo taking
// back a timeline move broke the spheres rule (Sam, Oct 30; evidence pass,
// Nov 25); ⌘Z still does.

import { historyView, matchingSteps, newestMatchingStep, type StepSummary } from "@/lib/history/history"

/** Step kinds that change or approve one take, named by `audioId`. */
const NOT_THE_STATIONS = new Set(["take.select", "take.cut", "take.place"])
const isTakeStep = (kind: string): boolean => kind === "vote.audio" || (kind.startsWith("take.") && !NOT_THE_STATIONS.has(kind))

/** The match for the Station's Undo while `audioId` on `cellId` is open. */
export function stationStepMatch(cellId: string, audioId: string): (kind: string, data: unknown) => boolean {
  return (kind, data) => {
    if (!isTakeStep(kind)) return false
    const d = data as { cellId?: unknown; audioId?: unknown; pieces?: unknown; run?: unknown } | null
    if (!d || d.cellId !== cellId) return false
    // AQU-2664 (board 73C): a run of Even out over a file or tracks is ⌘Z's,
    // not the Station's; a Clear made here (no `run`) is.
    if (kind === "take.even" && d.run) return false
    // A version made of a cut take names its other pieces beside the first.
    return d.audioId === audioId || (Array.isArray(d.pieces) && d.pieces.includes(audioId))
  }
}

/**
 * AQU-2493 (review, Nov 9): a step made of several parts is the Station's when
 * one part changes the open take and no part approves (or takes back the
 * approval of) any other take. Approving or un-approving audio from the
 * selection bar, or "Validate all audio", records the whole selection as one
 * step; counting it whenever one of its lines was the open take let the
 * Station's Undo take back thirty approvals. A bulk change made outside the
 * Station is never the Station's to undo. Its own groups — a save, which also
 * writes copies on the other lines that use the recording — approve nothing.
 */
export function stationGroupCounts(cellId: string, audioId: string): (parts: ReadonlyArray<{ kind: string; data: unknown }>) => boolean {
  const mine = stationStepMatch(cellId, audioId)
  return (parts) => parts.some((p) => mine(p.kind, p.data)) && !parts.some((p) => p.kind === "vote.audio" && !mine(p.kind, p.data))
}

/** The step the Station's own Undo takes back while `audioId` on `cellId` is open. */
export function newestStationStep(cellId: string, audioId: string): StepSummary | null {
  return newestMatchingStep(stationStepMatch(cellId, audioId), stationGroupCounts(cellId, audioId))
}

/**
 * AQU-2493 (review, Nov 9), finding 12: whether the open take was cut since
 * the Station's step `stepId` — a cut sits above it in Undo. A cut is made on
 * the timeline and is not the Station's to undo, but it changes the take, so
 * the Station's step would be judged "changed since" and dropped for good.
 * The Station's Undo then says so instead, and ⌘Z takes the cut back first.
 */
export function cutSinceStationStep(cellId: string, audioId: string, stepId: string): boolean {
  const isCut = (kind: string, data: unknown): boolean =>
    kind === "take.cut" &&
    ((data as { cuts?: ReadonlyArray<{ cellId?: string; audioId?: string; newAudioId?: string }> } | null)?.cuts ?? []).some(
      (c) => c.cellId === cellId && (c.audioId === audioId || c.newAudioId === audioId),
    )
  return matchingStepSince(isCut, stepId)
}

/**
 * Review of 152db3f40: whether the open take was moved on the timeline since
 * the Station's step `stepId`, the same way as a cut. A move is not the
 * Station's to undo, but undoing the Station's step under it can throw the
 * move away (a save's undo puts the old take back and the moved one goes,
 * and ⌘Z then finds nothing to move back). The Station's Undo then says so
 * instead, and ⌘Z takes the move back first.
 */
export function movedSinceStationStep(cellId: string, audioId: string, stepId: string): boolean {
  const isMove = (kind: string, data: unknown): boolean => {
    const d = data as { cellId?: unknown; audioId?: unknown } | null
    return kind === "take.place" && d?.cellId === cellId && d.audioId === audioId
  }
  return matchingStepSince(isMove, stepId)
}

/** Whether a step matching `match` sits above step `stepId` in Undo. */
function matchingStepSince(match: (kind: string, data: unknown) => boolean, stepId: string): boolean {
  const found = matchingSteps(match).undo
  if (found.length === 0) return false
  const order = historyView().undoSteps.map((s) => s.id)
  const at = order.indexOf(stepId)
  return found.some((c) => order.indexOf(c.id) > at)
}
