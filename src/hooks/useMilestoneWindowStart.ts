import { useEffect, useMemo, useState } from "react"
import type { CellData } from "@/hooks/useCells"
import { layOutProgramme, type ProgrammeTrackOptions } from "@/lib/timeline/programme"
import { milestoneWindowStartSec } from "@/lib/timeline/sequence-timeline"

/** A line's own times, following the source. */
const ownSpan = (c: CellData) =>
  typeof c.startTime === "number" && Number.isFinite(c.startTime)
    ? { start: c.startTime, end: typeof c.endTime === "number" && Number.isFinite(c.endTime) ? c.endTime : c.startTime }
    : null

/**
 * Sam, Nov 27: WITH SPLIT INTO MILESTONES ON, THE TIMELINE IS A WINDOW ONTO
 * THE FILM'S OWN CLOCK, and this is where it starts (`milestoneWindowStartSec`):
 * following the source, at the milestone's earliest line's own time; following
 * the recordings, where its first line sits in the whole file's layout. A
 * milestone whose lines have no times yet starts where the lines before it
 * ended. The whole file on the timeline (`partShown` false): 0:00. Null
 * before it has been worked out for this file.
 *
 * Following the source it is a pass over the milestone's lines, so it follows
 * every edit (a first line dragged earlier stays on the timeline). Following
 * the recordings it needs the whole file's layout, too much to redo on every
 * take on a weak device: worked out once per milestone (`milestoneKey`), and
 * again when lines are added or removed or the tracks change, never per
 * frame; the effect reads the lines of the render that ran it.
 */
export function useMilestoneWindowStart({
  fileId, partShown, milestoneKey, followsRecordings, tracks, shown, whole,
}: {
  fileId: string | null
  partShown: boolean
  milestoneKey: string | null
  followsRecordings: boolean
  tracks: ProgrammeTrackOptions
  /** The milestone's lines, as Play plays them. */
  shown: readonly CellData[]
  /** The whole file's lines, the same way, in the file's order. */
  whole: readonly CellData[]
}): number | null {
  const sourceStart = useMemo(
    () => (partShown && !followsRecordings ? milestoneWindowStartSec(shown, whole, ownSpan) : 0),
    [partShown, followsRecordings, shown, whole],
  )
  const [win, setWin] = useState<{ fileId: string | null; startSec: number }>({ fileId: null, startSec: 0 })
  const shownCount = shown.length
  const wholeCount = whole.length
  useEffect(() => {
    let startSec = 0
    if (partShown && followsRecordings) {
      const { programme } = layOutProgramme(whole, tracks)
      startSec = milestoneWindowStartSec(shown, whole, (c) => {
        const slot = programme.byCellId.get(c.id)
        return slot ? { start: slot.startSec, end: slot.startSec + slot.slotLenSec } : null
      })
    }
    setWin((cur) => (cur.startSec === startSec && cur.fileId === fileId ? cur : { fileId, startSec }))
    // Keyed on what decides the window, not on the lines themselves (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partShown, milestoneKey, followsRecordings, fileId, tracks, shownCount, wholeCount])
  if (!followsRecordings) return sourceStart
  // Null until it has been worked out for this file (the first render after
  // opening one); a milestone turned to keeps the last start for that one
  // render rather than jumping to the whole file.
  return win.fileId === fileId ? win.startSec : null
}
