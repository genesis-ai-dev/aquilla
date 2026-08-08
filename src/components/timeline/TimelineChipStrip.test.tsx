import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"

import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
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
    expect(screen.getByText(/Source: 0:10\.0–0:15\.0 · 5\.0s/)).toBeInTheDocument()
    expect(screen.getByTestId("tl-detail-dub-range")).toHaveTextContent("Target: 0:10.0–0:14.3")
    expect(screen.getByTestId("tl-detail-duration")).toHaveTextContent("4.3s")
    expect(screen.getByTestId("tl-detail-diff")).toHaveTextContent("Diff: +0.7s")
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

  it("the Diff hover breaks the difference into its start and end halves", async () => {
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
    await expectTooltip(screen.getByTestId("tl-detail-diff"), /Start: −0\.6s · End: −0\.8s/)
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

  it("labels the section, and keeps labelling it with nothing selected", () => {
    const { rerender } = render(<MediaTextHeader cell={cell({ startTime: 1, endTime: 3 })} />)
    expect(screen.getByTestId("tl-dialogue-header")).toHaveTextContent("Dialogue")
    // A subtitle chip renames it; an empty selection falls back to the section
    // name rather than blinking the label out of existence.
    rerender(<MediaTextHeader cell={cell({ medium: "text", startTime: 1, endTime: 3 })} />)
    expect(screen.getByTestId("tl-dialogue-header")).toHaveTextContent("Subtitle")
    rerender(<MediaTextHeader cell={null} />)
    expect(screen.getByTestId("tl-dialogue-header")).toHaveTextContent("Dialogue")
  })

  it("carries no timings — those measure the chips, not this list", () => {
    render(
      <MediaTextHeader cell={cell({ startTime: 10, endTime: 15, metadata: { cast_name: "Mary" } })} />,
    )
    expect(screen.queryByTestId("tl-detail")).toBeNull()
    expect(screen.queryByText(/^Source:/)).toBeNull()
    expect(screen.queryByText(/Diff:/)).toBeNull()
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
