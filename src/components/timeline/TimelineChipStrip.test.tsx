import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"

import { expectClickNote, renderWithTooltips } from "@/test-utils/tooltip"
import { MediaTextHeader, TimelineTimingRow } from "./TimelineChipStrip"
import { MISSING_AUDIO_MESSAGE } from "@/lib/audio/play-queue"
import type { CellData } from "@/hooks/useCells"

const cell = (o: Partial<CellData>): CellData =>
  ({ id: "c1", fileId: "f1", original: "", translated: "", medium: "media", ...o }) as unknown as CellData

// Ported from TimelineCellDetail.test.tsx when the pane became this strip
// (2026-08-07): the pill row's copy and styling are the contract several
// browser passes read — testids and wording must not drift.
describe("TimelineTimingRow", () => {
  it("labels the pills Source/Target/Diff and shows range + duration for both sides", () => {
    render(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{
          kind: "dubbing", startSec: 10, endSec: 14.3, durationSec: 4.3,
          startDiffSec: 0, endDiffSec: 0.7, durationDiffSec: 0.7,
          headOverlapSec: null, tailOverlapSec: null,
        }}
      />,
    )
    expect(screen.getByText(/Source: 0:10\.0–0:15\.0 \| 5\.0s/)).toBeInTheDocument()
    expect(screen.getByTestId("tl-detail-dub-range")).toHaveTextContent("Target: 0:10.0–0:14.3")
    expect(screen.getByTestId("tl-detail-duration")).toHaveTextContent("4.3s")
    expect(screen.getByTestId("tl-detail-diff")).toHaveTextContent("Diff: +0.7s")
    // A whole take says nothing about pieces.
    expect(screen.queryByTestId("tl-detail-pieces")).toBeNull()
  })

  // AQU-1767 (Sam, 2026-10-19): a split take's Target pill names its pieces.
  it("a take cut into pieces reads 'N pieces · sound kept' after its span", () => {
    render(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 2, endTime: 6.5 })}
        chipStats={{
          kind: "dubbing", startSec: 1.5, endSec: 5.5, durationSec: 3.5, pieces: 3,
          startDiffSec: -0.5, endDiffSec: 1, durationDiffSec: 0.5,
          headOverlapSec: null, tailOverlapSec: null,
        }}
      />,
    )
    expect(screen.getByTestId("tl-detail-dub-range")).toHaveTextContent("Target: 0:01.5–0:05.5 | 3 pieces · 3.5s")
    expect(screen.getByTestId("tl-detail-diff")).toHaveTextContent("Diff: +0.5s")
  })

  // 2026-08-08 (Sam): Diff is the whole DURATION difference — the old
  // end-only number was blind to a dub that also starts before its verse.
  it("Diff counts BOTH ends: a dub starting early and ending late reads its full extra length", () => {
    render(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        // Verse 10–15 (5.0s); dub 9.4–15.8 (6.4s) → 1.4s longer overall.
        chipStats={{
          kind: "dubbing", startSec: 9.4, endSec: 15.8, durationSec: 6.4,
          startDiffSec: -0.6, endDiffSec: -0.8, durationDiffSec: -1.4,
          headOverlapSec: null, tailOverlapSec: null,
        }}
      />,
    )
    expect(screen.getByTestId("tl-detail-diff")).toHaveTextContent("Diff: −1.4s")
  })

  // AQU-2260 (Sam, Oct 29): on a click of the pill, never a hover.
  it("the Diff note breaks the difference into its start and end halves", async () => {
    renderWithTooltips(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{
          kind: "dubbing", startSec: 9.4, endSec: 15.8, durationSec: 6.4,
          startDiffSec: -0.6, endDiffSec: -0.8, durationDiffSec: -1.4,
          headOverlapSec: null, tailOverlapSec: null,
        }}
      />,
    )
    await expectClickNote(screen.getByTestId("tl-detail-diff"), /Start: −0\.6s · End: −0\.8s/)
  })

  it("a negative Diff is INFORMATIONAL — labeled, never red (2026-08-06)", () => {
    render(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{
          kind: "dubbing", startSec: 11, endSec: 15.8, durationSec: 4.8,
          startDiffSec: 1, endDiffSec: -0.8, durationDiffSec: 0.2,
          headOverlapSec: null, tailOverlapSec: null,
        }}
      />,
    )
    const diff = screen.getByTestId("tl-detail-diff")
    expect(diff.className).not.toContain("text-red")
  })

  it("chip-vs-chip OVERLAP gets its own red pill — the real warning", () => {
    render(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{
          kind: "dubbing", startSec: 9, endSec: 14, durationSec: 5,
          startDiffSec: -1, endDiffSec: 1, durationDiffSec: 0,
          headOverlapSec: 1.8, tailOverlapSec: null,
        }}
      />,
    )
    const overlap = screen.getByTestId("tl-detail-overlap")
    expect(overlap).toHaveTextContent("Overlap: −1.8s")
    expect(overlap.className).toContain("text-red-600")
    // AQU-2260: which neighbour it runs over opens on a click, never a hover.
    expect(overlap).not.toHaveAttribute("title")
    // …and the informational Diff stays neutral beside it.
    expect(screen.getByTestId("tl-detail-diff").className).not.toContain("text-red")
    // One side only → no labeled pills.
    expect(screen.queryByTestId("tl-detail-overlap-start")).toBeNull()
    expect(screen.queryByTestId("tl-detail-overlap-end")).toBeNull()
  })

  it("tail-only overlap uses the same single pill", () => {
    render(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{
          kind: "dubbing", startSec: 10, endSec: 16.2, durationSec: 6.2,
          startDiffSec: 0, endDiffSec: -1.2, durationDiffSec: -1.2,
          headOverlapSec: null, tailOverlapSec: 1.2,
        }}
      />,
    )
    expect(screen.getByTestId("tl-detail-overlap")).toHaveTextContent("Overlap: −1.2s")
  })

  // 2026-08-08 (Sam): a chip colliding at BOTH ends needs two numbers — a
  // single sum would say nothing about where the collision is.
  it("overlap on BOTH sides splits into labeled start/end pills", () => {
    render(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{
          kind: "dubbing", startSec: 9.3, endSec: 16.1, durationSec: 6.8,
          startDiffSec: -0.7, endDiffSec: -1.1, durationDiffSec: -1.8,
          headOverlapSec: 0.7, tailOverlapSec: 1.1,
        }}
      />,
    )
    const start = screen.getByTestId("tl-detail-overlap-start")
    const end = screen.getByTestId("tl-detail-overlap-end")
    expect(start).toHaveTextContent("Start overlap: −0.7s")
    expect(end).toHaveTextContent("End overlap: −1.1s")
    expect(start.className).toContain("text-red-600")
    expect(end.className).toContain("text-red-600")
    expect(start).not.toHaveAttribute("title")
    expect(end).not.toHaveAttribute("title")
    // The undifferentiated pill must NOT also render.
    expect(screen.queryByTestId("tl-detail-overlap")).toBeNull()
  })

  it("no overlap pill when the chip doesn't collide", () => {
    render(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{
          kind: "dubbing", startSec: 10, endSec: 14, durationSec: 4,
          startDiffSec: 0, endDiffSec: 1, durationDiffSec: 1,
          headOverlapSec: null, tailOverlapSec: null,
        }}
      />,
    )
    expect(screen.queryByTestId("tl-detail-overlap")).toBeNull()
    expect(screen.queryByTestId("tl-detail-overlap-start")).toBeNull()
    expect(screen.queryByTestId("tl-detail-overlap-end")).toBeNull()
  })

  it("FREE TIMING: durations only — the file-clock range never renders (2026-08-06)", () => {
    render(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 13.8, endTime: 15.4 })}
        chipStats={{ kind: "free", srcDurationSec: 1.6, tgtDurationSec: 4.6 }}
      />,
    )
    expect(screen.getByTestId("tl-detail-src-duration")).toHaveTextContent("Source: 1.6s")
    expect(screen.getByTestId("tl-detail-tgt-duration")).toHaveTextContent("Target: 4.6s")
    // No ranges, no diff, no overlap — the file clock doesn't match the track.
    expect(screen.queryByText(/0:13\.8/)).toBeNull()
    expect(screen.queryByTestId("tl-detail-dub-range")).toBeNull()
    expect(screen.queryByTestId("tl-detail-diff")).toBeNull()
    expect(screen.queryByTestId("tl-detail-overlap")).toBeNull()
  })

  it("FREE TIMING: an unmeasured dub shows only the source duration", () => {
    render(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 13.8, endTime: 15.4 })}
        chipStats={{ kind: "free", srcDurationSec: 1.6, tgtDurationSec: null }}
      />,
    )
    expect(screen.getByTestId("tl-detail-src-duration")).toHaveTextContent("Source: 1.6s")
    expect(screen.queryByTestId("tl-detail-tgt-duration")).toBeNull()
  })

  it("shows no dub numbers without chipStats (no measured dub / free timing)", () => {
    render(<TimelineTimingRow cell={cell({ original: "x", startTime: 1, endTime: 3 })} />)
    expect(screen.queryByTestId("tl-detail-dub-range")).toBeNull()
    expect(screen.queryByTestId("tl-detail-diff")).toBeNull()
    // A chip-less cell's range pill stays unlabeled — nothing to contrast with.
    expect(screen.queryByText(/^Source:/)).toBeNull()
  })

  it("renders an empty state with no current chip", () => {
    render(<TimelineTimingRow cell={null} />)
    expect(screen.getByTestId("tl-detail-empty")).toBeInTheDocument()
  })

  it("carries the current cell's id for selection proofs", () => {
    render(<TimelineTimingRow cell={cell({ id: "d7", startTime: 1, endTime: 3 })} />)
    expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "d7")
  })

  it("missing audio joins the pill row as a compact red pill", () => {
    render(<TimelineTimingRow cell={cell({ startTime: 1, endTime: 3 })} audioMissing />)
    const badge = screen.getByTestId("tl-detail-audio-missing")
    expect(badge).toHaveTextContent(MISSING_AUDIO_MESSAGE)
    expect(badge.className).toContain("text-red-600")
  })

})

// 2026-08-08: the header half. It says what SECTION and what LINE — never what
// the chip measures, which is the timeline's business one row up.
describe("MediaTextHeader", () => {
  it("shows Speaker and Camera context pills when the cell carries them", () => {
    render(
      <MediaTextHeader
        cell={cell({ startTime: 1, endTime: 3, metadata: { cast_name: "Mary" }, cameraState: "on" })}
      />,
    )
    expect(screen.getByText("Mary")).toBeInTheDocument()
    expect(screen.getByText("on")).toBeInTheDocument()
  })

  // Media redesign, layout: the row lost its heading and its layout controls.
  // The Text panel's strip above names the panel and carries Full screen,
  // Fold and ⋯; this row says only what the current line says about itself.
  it("has no heading and no layout controls of its own", () => {
    render(<MediaTextHeader cell={cell({ startTime: 1, endTime: 3 })} />)
    const row = screen.getByTestId("tl-dialogue-header")
    expect(row).not.toHaveTextContent("Dialogue")
    expect(row).not.toHaveTextContent("Subtitle")
    expect(row.querySelector("button")).toBeNull()
  })

  it("keeps the Camera pill hidden for a text cell", () => {
    // `isDialogue` still (correctly) gates this pill.
    render(<MediaTextHeader cell={cell({ medium: "text", startTime: 1, endTime: 3, cameraState: "on" })} />)
    expect(screen.queryByText("on")).toBeNull()
  })

  it("carries no timings — those measure the chips, not this list", () => {
    render(
      <MediaTextHeader cell={cell({ startTime: 10, endTime: 15, metadata: { cast_name: "Mary" } })} />,
    )
    expect(screen.queryByTestId("tl-detail")).toBeNull()
    expect(screen.queryByText(/^Source:/)).toBeNull()
    expect(screen.queryByText(/Diff:/)).toBeNull()
  })

  // AQU-646 stage 6. The character sheet is keyed to the SUBTITLE cells, and
  // since stage 4 the chip you select is an audio CUE, which carries no
  // `cast_name` of its own — so this header named nobody exactly when it
  // mattered. TimelineEditor now resolves the character through the cue's
  // links and hands the answer down.
  describe("a resolved character, for a cue that has none of its own", () => {
    /** What a cue looks like here: a text cell with no cast metadata. */
    const cueCell = cell({ medium: "text", startTime: 1, endTime: 3 })

    it("names the character resolved through the links", () => {
      render(<MediaTextHeader cell={cueCell} castName="Mary" cameraState="on" />)
      expect(screen.getByText("Mary")).toBeInTheDocument()
    })

    it("shows a resolved camera state even though the cell is not a dub", () => {
      // The pill is otherwise gated on `isDialogue`, which is correctly false
      // here. A state that arrived through a link has already earned its way
      // in — showing it is the entire point of resolving it.
      render(<MediaTextHeader cell={cueCell} castName="Mary" cameraState="on" />)
      expect(screen.getByText("on")).toBeInTheDocument()
    })

    it("shows both speakers of a cue that covers two lines", () => {
      // Five do, in episode 101 — 10:53's "Rabbi." is two students. The
      // resolver joins them; this header just prints what it is given,
      // rather than picking one.
      render(<MediaTextHeader cell={cueCell} castName="Jesus / Mary" cameraState="mixed" />)
      expect(screen.getByText("Jesus / Mary")).toBeInTheDocument()
      expect(screen.getByText("mixed")).toBeInTheDocument()
    })

    it("names nobody for an unlinked cue rather than guessing", () => {
      render(<MediaTextHeader cell={cueCell} castName={null} cameraState={null} />)
      expect(screen.queryByText(/Speaker/)).toBeNull()
      expect(screen.queryByText(/Camera/)).toBeNull()
    })

    it("leaves the cell's own character in charge when nothing is resolved", () => {
      // The dialogue-table arrangement, and every file without audio cues.
      render(<MediaTextHeader cell={cell({ metadata: { cast_name: "Mary" }, cameraState: "off" })} />)
      expect(screen.getByText("Mary")).toBeInTheDocument()
      expect(screen.getByText("off")).toBeInTheDocument()
    })
  })

  it("hosts the segment navigator's portal slot in every state", () => {
    const { rerender } = render(<MediaTextHeader cell={null} />)
    const slot = screen.getByTestId("tl-strip-nav")
    rerender(<MediaTextHeader cell={cell({ startTime: 1, endTime: 3 })} />)
    // Same node across a selection change — the table portals into it, and a
    // remount would tear that portal down.
    expect(screen.getByTestId("tl-strip-nav")).toBe(slot)
  })
})

// AQU-2260 (Sam, Oct 29): an overlap pill says which neighbour it runs over on
// a click of it.
describe("TimelineTimingRow — overlap pills explain themselves on a click", () => {
  it("the single pill says it sounds over a neighbour", async () => {
    renderWithTooltips(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{
          kind: "dubbing", startSec: 9, endSec: 14, durationSec: 5,
          startDiffSec: -1, endDiffSec: 1, durationDiffSec: 0,
          headOverlapSec: 1.8, tailOverlapSec: null,
        }}
      />,
    )
    await expectClickNote(screen.getByTestId("tl-detail-overlap"), "neighbouring verse")
  })

  it("the start and end pills each name their neighbour", async () => {
    renderWithTooltips(
      <TimelineTimingRow
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{
          kind: "dubbing", startSec: 9.3, endSec: 16.1, durationSec: 6.8,
          startDiffSec: -0.7, endDiffSec: -1.1, durationDiffSec: -1.8,
          headOverlapSec: 0.7, tailOverlapSec: 1.1,
        }}
      />,
    )
    await expectClickNote(screen.getByTestId("tl-detail-overlap-start"), "PREVIOUS verse")
  })
})
