// The readouts that describe the CURRENT chip: the timing row under the
// lanes and the text header opposite the video.
//
// With nothing selected the current chip is the line the queue is sounding,
// so it changes on every line of playback. Read in the editor, that change
// re-rendered the editor and redrew every mounted time column — a long task at
// each line, and on letting go of a dragged playhead, which cues a new one.
// Here it re-renders this and nothing else.

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react"
import { createPortal } from "react-dom"
import type { CellData } from "@/hooks/useCells"
import { useQueueStateValue } from "@/lib/audio/play-queue"
import { selectQueueStateForFile } from "@/lib/audio/queue-scope"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CueLinkIndex } from "@/lib/sync/cell-links-read"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { resolveCueCharacter, formatCueCharacter } from "@/lib/timeline/cue-character"
import { chipOverlaps } from "@/lib/timeline/lane-timing"
import type { TimelineLayout } from "@/lib/timeline/layout"
import type { TargetAudioItem } from "./TargetAudioLane"
import { MediaTextHeader, TimelineTimingRow } from "./TimelineChipStrip"
import { resolveEntryAudio, useClipAudioMissing } from "./useClipAudioMissing"

type MediaTextHeaderProps = Parameters<typeof MediaTextHeader>[0]

export interface TimelineCurrentChipProps {
  cellIds: ReadonlySet<string>
  selectedId: string | null
  setSelectedId: Dispatch<SetStateAction<string | null>>
  cells: readonly CellData[]
  audioCues?: readonly CellData[] | null
  independentTextCells: readonly CellData[]
  links: CueLinkIndex
  audioFirst: boolean
  targetItems: readonly TargetAudioItem[]
  layout: TimelineLayout
  audioByCellId?: Map<string, CellAudioEntry>
  projectId: string | null
  fileId: string
  session: FrontierSession | null
  /** The workspace's slot for the header; null renders it inline (tests). */
  chipStripSlot: HTMLElement | null
  /** Everything the header shows that is not about the current chip. */
  header: Omit<MediaTextHeaderProps, "cell" | "castName" | "cameraState">
}

export function TimelineCurrentChip({
  cellIds, selectedId, setSelectedId, cells, audioCues, independentTextCells, links,
  audioFirst, targetItems, layout, audioByCellId, projectId, fileId, session, chipStripSlot, header,
}: TimelineCurrentChipProps) {
  // 2026-08-07: the chip strip describes the CURRENT chip — an explicit
  // selection wins; with nothing selected it follows the cell the queue is
  // sounding (or holds while paused); after the queue goes idle it keeps the
  // last one so the strip doesn't blank out mid-thought. Same file guard as the
  // playhead: a stale singleton queue never fills this file's strip.
  const soundingId = useQueueStateValue((state) => {
    const queue = selectQueueStateForFile(state, cellIds)
    return queue.active ? queue.cellId : null
  })
  // Kept during render, not in an effect: an effect's update rendered this a
  // second time on each line of playback.
  const [lastTouchedId, setLastTouchedId] = useState<string | null>(null)
  const touchedId = selectedId ?? soundingId
  if (touchedId && touchedId !== lastTouchedId) setLastTouchedId(touchedId)
  // 2026-08-08 (Sam): an AUTOMATIC playback advance clears the selection —
  // one pointer, one moving light. EDGE-triggered on the sounding cell's
  // transitions: only when the queue moves from A to B (both non-null) and
  // the departed A was the selected cell does the selection drop. A fresh
  // click-then-jump is race-proof by construction (its selection ≠ the
  // departed cell), untimed selections survive (they never sound), and
  // pause/idle produce no transition, so nothing clears.
  const prevSoundingRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevSoundingRef.current
    prevSoundingRef.current = soundingId
    if (prev == null || soundingId == null || soundingId === prev) return
    setSelectedId((sel) => (sel === prev ? null : sel))
  }, [soundingId])
  const currentCellId = selectedId ?? soundingId ?? lastTouchedId
  // Searches the AUDIO CUES too (stage 4): a cue is a legitimate selection now,
  // and it lives in the hidden sibling file, so looking only in `cells` left the
  // timing readout blank for every chip on the Source-audio row.
  const currentCell = useMemo(
    () =>
      cells.find((c) => c.id === currentCellId) ??
      audioCues?.find((c) => c.id === currentCellId) ??
      independentTextCells.find((c) => c.id === currentCellId) ??
      null,
    [cells, audioCues, independentTextCells, currentCellId],
  )
  // AQU-646 stage 6: who speaks the current chip, and whether the camera is on
  // them. Resolved HERE because this is the one place that holds both halves —
  // the links and the subtitle cells the character sheet was keyed to. A cue
  // has no character of its own, so without this the header opposite the video
  // named nobody for the only kind of chip stage 4 leaves you selecting.
  const currentCharacter = useMemo(
    () => resolveCueCharacter({ cell: currentCell, links, textCells: cells }),
    [currentCell, links, cells],
  )
  // Meeting note (2026-08-05): the detail readout carries the dub's own
  // numbers — its range, its duration, and ALWAYS the end-to-end difference
  // (original end − dub end). 2026-08-06 (Sam): the diff is INFORMATIONAL (a
  // difference can be intentional) — chip-vs-chip OVERLAP is the warning, a
  // separate number computed with the same trespasser gating the lane uses.
  // Dubbing only, and never from a guessed width (SUB-48).
  const currentChipStats = useMemo(() => {
    if (!currentCell) return null
    // Free timing (2026-08-06, Sam): the file-clock RANGES are meaningless
    // against the re-flowed track — the only honest numbers are durations.
    // Src = the original's window length, Tgt = the dub's measured length.
    if (audioFirst) {
      // AQU-2204 (Sam, Oct 26): a file that follows its recordings shows no
      // SOURCE timing anywhere — not even the original's length — so only the
      // recording's own length is read out.
      const srcDurationSec = null
      // AQU-1767: a split take's length is all its pieces'.
      const geoms = targetItems
        .filter((t) => t.cell.id === currentCell.id)
        .map((t) => layout.targetGeom(t.cell, t.cell.attachments?.[t.audioId], t.audioId))
      const tgtDurationSec = geoms.length > 0 && geoms.every((g) => g && !g.usingFallback)
        ? geoms.reduce((sum, g) => sum + (g!.end - g!.start), 0)
        : null
      // Always the free readout, even with nothing measured: falling back to
      // the plain row would print the line's SOURCE range.
      return { kind: "free" as const, srcDurationSec, tgtDurationSec }
    }
    // AQU-1767: a split take's pieces are consecutive items, and the pills read
    // them as the one take they are (Sam, 2026-10-19): from the first piece's
    // start to the last piece's end, the sound they keep added up, and how many
    // pieces. Diff and overlap measure that span against the line and its
    // neighbours — the silences between pieces are inside the take.
    const first = targetItems.findIndex((t) => t.cell.id === currentCell.id)
    if (first < 0) return null
    let last = first
    while (targetItems[last + 1]?.cell.id === currentCell.id) last += 1
    const geomOf = (t: (typeof targetItems)[number] | undefined) =>
      t ? layout.targetGeom(t.cell, t.cell.attachments?.[t.audioId], t.audioId) : null
    const pieceGeoms = targetItems.slice(first, last + 1).map(geomOf)
    if (pieceGeoms.some((g) => !g || g.usingFallback)) return null
    const spans = pieceGeoms.map((g) => ({ start: g!.start, end: g!.end }))
    const geom = {
      start: Math.min(...spans.map((s) => s.start)),
      end: Math.max(...spans.map((s) => s.end)),
    }
    const soundSec = spans.reduce((sum, s) => sum + (s.end - s.start), 0)
    const { startTime, endTime } = currentCell
    const prev = geomOf(targetItems[first - 1])
    const next = geomOf(targetItems[last + 1])
    const { headSec, tailSec } = chipOverlaps(
      geom,
      prev ? { start: prev.start, end: prev.end } : null,
      next?.start ?? null,
    )
    // Blame the trespasser (same rule as the chip): only territory THIS chip
    // left its own section to claim counts toward its overlap number. The
    // head half also depends on the PREVIOUS chip's end, so it is masked when
    // that width is a guess (SUB-48 — same mask the lane applies).
    // 2026-08-08 (Sam): the two halves stay SEPARATE — a chip that spills at
    // both ends reads as two labeled numbers, not one meaningless sum.
    const tailTrespass = tailSec != null && typeof endTime === "number" && geom.end > endTime ? tailSec : 0
    const headTrespass =
      headSec != null && !prev?.usingFallback && typeof startTime === "number" && geom.start < startTime
        ? headSec
        : 0
    // 2026-08-08 (Sam): Diff is the whole DURATION difference now. The old
    // end-only number missed a target that also starts before its verse:
    // start + end diffs sum to (source duration − target duration), positive
    // exactly when the target is shorter. The halves survive in the hover.
    const startDiffSec = typeof startTime === "number" ? geom.start - startTime : null
    const endDiffSec = typeof endTime === "number" ? endTime - geom.end : null
    return {
      kind: "dubbing" as const,
      startSec: geom.start,
      endSec: geom.end,
      durationSec: soundSec,
      ...(spans.length > 1 ? { pieces: spans.length } : {}),
      startDiffSec,
      endDiffSec,
      durationDiffSec: startDiffSec != null && endDiffSec != null ? startDiffSec + endDiffSec : null,
      headOverlapSec: headTrespass > 0 ? headTrespass : null,
      tailOverlapSec: tailTrespass > 0 ? tailTrespass : null,
    }
  }, [audioFirst, currentCell, targetItems, layout])
  const currentClipAudio = useMemo(
    () => (currentCellId ? resolveEntryAudio(audioByCellId?.get(currentCellId)) : null),
    [audioByCellId, currentCellId],
  )
  const audioMissing = useClipAudioMissing({
    audio: currentClipAudio,
    projectId,
    fileId,
    session,
  })

  const headerProps: MediaTextHeaderProps = {
    ...header,
    cell: currentCell,
    castName: formatCueCharacter(currentCharacter.names),
    cameraState: currentCharacter.cameraState ?? null,
  }
  return (
    <>
      {/* 2026-08-08 (Sam): the NUMBERS stay with the timeline — they measure
          the chips above, not the dialogue below — and close this section off
          at its bottom edge. The wrapper is the row's `shrink-0`: it is chrome,
          and the panel's height belongs to the tracks. */}
      <div className="shrink-0">
        <TimelineTimingRow cell={currentCell} chipStats={currentChipStats} audioMissing={audioMissing} />
      </div>
      {/* The section label, the line's own context and the segment navigator
          head the TEXT column of the band below, opposite the Video header.
          The slot is owned by the workspace; portal when it exists, render
          inline when this editor is mounted alone (tests). */}
      {chipStripSlot
        ? createPortal(<MediaTextHeader {...headerProps} />, chipStripSlot)
        : <MediaTextHeader {...headerProps} />}
    </>
  )
}
