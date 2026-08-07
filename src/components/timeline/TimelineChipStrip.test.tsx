import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"

import { TimelineChipStrip } from "./TimelineChipStrip"
import { MISSING_AUDIO_MESSAGE } from "@/lib/audio/play-queue"
import type { CellData } from "@/hooks/useCells"

const cell = (o: Partial<CellData>): CellData =>
  ({ id: "c1", fileId: "f1", original: "", translated: "", medium: "media", ...o }) as unknown as CellData

// Ported from TimelineCellDetail.test.tsx when the pane became this strip
// (2026-08-07): the pill row's copy and styling are the contract several
// browser passes read — testids and wording must not drift.
describe("TimelineChipStrip", () => {
  it("labels the pills Source/Target/Diff and shows range + duration for both sides", () => {
    render(
      <TimelineChipStrip
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{ kind: "dubbing", startSec: 10, endSec: 14.3, durationSec: 4.3, endDiffSec: 0.7, overlapSec: null }}
      />,
    )
    expect(screen.getByText(/Source: 0:10\.0–0:15\.0 · 5\.0s/)).toBeInTheDocument()
    expect(screen.getByTestId("tl-detail-dub-range")).toHaveTextContent("Target: 0:10.0–0:14.3")
    expect(screen.getByTestId("tl-detail-duration")).toHaveTextContent("4.3s")
    expect(screen.getByTestId("tl-detail-enddiff")).toHaveTextContent("Diff: +0.7s")
  })

  it("a negative Diff is INFORMATIONAL — labeled, never red (2026-08-06)", () => {
    render(
      <TimelineChipStrip
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{ kind: "dubbing", startSec: 11, endSec: 15.8, durationSec: 4.8, endDiffSec: -0.8, overlapSec: null }}
      />,
    )
    const diff = screen.getByTestId("tl-detail-enddiff")
    expect(diff).toHaveTextContent("Diff: −0.8s")
    expect(diff.className).not.toContain("text-red")
  })

  it("chip-vs-chip OVERLAP gets its own red pill — the real warning", () => {
    render(
      <TimelineChipStrip
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{ kind: "dubbing", startSec: 9, endSec: 14, durationSec: 5, endDiffSec: 1, overlapSec: 1.8 }}
      />,
    )
    const overlap = screen.getByTestId("tl-detail-overlap")
    expect(overlap).toHaveTextContent("Overlap: −1.8s")
    expect(overlap.className).toContain("text-red-600")
    // …and the informational Diff stays neutral beside it.
    expect(screen.getByTestId("tl-detail-enddiff").className).not.toContain("text-red")
  })

  it("no overlap pill when the chip doesn't collide", () => {
    render(
      <TimelineChipStrip
        cell={cell({ original: "x", startTime: 10, endTime: 15 })}
        chipStats={{ kind: "dubbing", startSec: 10, endSec: 14, durationSec: 4, endDiffSec: 1, overlapSec: null }}
      />,
    )
    expect(screen.queryByTestId("tl-detail-overlap")).toBeNull()
  })

  it("FREE TIMING: durations only — the file-clock range never renders (2026-08-06)", () => {
    render(
      <TimelineChipStrip
        cell={cell({ original: "x", startTime: 13.8, endTime: 15.4 })}
        chipStats={{ kind: "free", srcDurationSec: 1.6, tgtDurationSec: 4.6 }}
      />,
    )
    expect(screen.getByTestId("tl-detail-src-duration")).toHaveTextContent("Source: 1.6s")
    expect(screen.getByTestId("tl-detail-tgt-duration")).toHaveTextContent("Target: 4.6s")
    // No ranges, no diff, no overlap — the file clock doesn't match the track.
    expect(screen.queryByText(/0:13\.8/)).toBeNull()
    expect(screen.queryByTestId("tl-detail-dub-range")).toBeNull()
    expect(screen.queryByTestId("tl-detail-enddiff")).toBeNull()
    expect(screen.queryByTestId("tl-detail-overlap")).toBeNull()
  })

  it("FREE TIMING: an unmeasured dub shows only the source duration", () => {
    render(
      <TimelineChipStrip
        cell={cell({ original: "x", startTime: 13.8, endTime: 15.4 })}
        chipStats={{ kind: "free", srcDurationSec: 1.6, tgtDurationSec: null }}
      />,
    )
    expect(screen.getByTestId("tl-detail-src-duration")).toHaveTextContent("Source: 1.6s")
    expect(screen.queryByTestId("tl-detail-tgt-duration")).toBeNull()
  })

  it("shows no dub numbers without chipStats (no measured dub / free timing)", () => {
    render(<TimelineChipStrip cell={cell({ original: "x", startTime: 1, endTime: 3 })} />)
    expect(screen.queryByTestId("tl-detail-dub-range")).toBeNull()
    expect(screen.queryByTestId("tl-detail-enddiff")).toBeNull()
    // A chip-less cell's range pill stays unlabeled — nothing to contrast with.
    expect(screen.queryByText(/^Source:/)).toBeNull()
  })

  it("renders an empty state with no current chip", () => {
    render(<TimelineChipStrip cell={null} />)
    expect(screen.getByTestId("tl-detail-empty")).toBeInTheDocument()
  })

  it("carries the current cell's id for selection proofs", () => {
    render(<TimelineChipStrip cell={cell({ id: "d7", startTime: 1, endTime: 3 })} />)
    expect(screen.getByTestId("tl-detail")).toHaveAttribute("data-cell-id", "d7")
  })

  it("missing audio joins the pill row as a compact red pill", () => {
    render(<TimelineChipStrip cell={cell({ startTime: 1, endTime: 3 })} audioMissing />)
    const badge = screen.getByTestId("tl-detail-audio-missing")
    expect(badge).toHaveTextContent(MISSING_AUDIO_MESSAGE)
    expect(badge.className).toContain("text-red-600")
  })

  it("shows Speaker and Camera context pills when the cell carries them", () => {
    render(
      <TimelineChipStrip
        cell={cell({ startTime: 1, endTime: 3, metadata: { cast_name: "Mary" }, cameraState: "on" })}
      />,
    )
    expect(screen.getByText("Mary")).toBeInTheDocument()
    expect(screen.getByText("on")).toBeInTheDocument()
  })
})
