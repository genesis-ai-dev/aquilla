// AQU-2664 (board 73C): which history steps the Station's own Undo takes back.

/** Is this step one the Station's own Undo takes back: a change to the take
 *  open here — but not a run of Even out over a file or tracks (board 73C:
 *  that is ⌘Z's), while a Clear made here is. */
export function stationOwnsStep(cellId: string, audioId: string) {
  return (kind: string, data: unknown): boolean => {
    const d = data as { cellId?: string; audioId?: string; run?: boolean } | null
    if (kind === "take.even" && d?.run) return false
    return d?.cellId === cellId && (d.audioId === undefined || d.audioId === audioId)
  }
}
