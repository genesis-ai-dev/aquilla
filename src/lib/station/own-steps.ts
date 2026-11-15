// Which Undo steps are the Station's own (AQU-2327, Q4; Sam, Oct 30: "even in
// the station, it should only apply to the station").
//
// AQU-2493 (review, Nov 9): the Station's Undo button takes back the last
// change to the OPEN RECORDING and nothing else. The rule before matched any
// step that named the line and carried no take id, so a translation edit, a
// text approval, a retime or a hide on the same line lit the button up and
// was taken back from here. Now a step is the Station's only when it is a
// change to a take (trim, volume and fades, move, rename, a saved or cleaned
// version, a delete) or an approval of one, and it names this take.

import { historyView, matchingSteps, newestMatchingStep, type StepSummary } from "@/lib/history/history"

/** Step kinds that change or approve one take, named by `audioId`. */
const isTakeStep = (kind: string): boolean => kind === "vote.audio" || (kind.startsWith("take.") && kind !== "take.select" && kind !== "take.cut")

/** The match for the Station's Undo while `audioId` on `cellId` is open. */
export function stationStepMatch(cellId: string, audioId: string): (kind: string, data: unknown) => boolean {
  return (kind, data) => {
    if (!isTakeStep(kind)) return false
    const d = data as { cellId?: unknown; audioId?: unknown; pieces?: unknown } | null
    if (!d || d.cellId !== cellId) return false
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
  const cuts = matchingSteps(isCut).undo
  if (cuts.length === 0) return false
  const order = historyView().undoSteps.map((s) => s.id)
  const at = order.indexOf(stepId)
  return cuts.some((c) => order.indexOf(c.id) > at)
}
