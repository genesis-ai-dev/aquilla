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
