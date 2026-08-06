// Rounds 6-7 (SUB-36 + DAW pass): honest, movable, TRIMMABLE dub chips —
// clip-zero anchored geometry, overlap-over-next rendering, z-order,
// resize-as-trim commits.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import type { CellData } from "@/hooks/useCells"

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

function item(
  over: Partial<CellData> = {},
  durationMs?: number,
  id = "c1",
  trims: { trimStartMs?: number; trimEndMs?: number } = {},
): TargetAudioItem {
  const takeId = `audio-${id}-1700000000-take.webm`
  const cell = {
    id, fileId: "f1", original: "", translated: "",
    medium: "media", startTime: 10, endTime: 20,
    selectedAudioId: takeId,
    attachments: {
      [takeId]: { type: "audio", url: "frontier-audio://take", ...(durationMs != null ? { durationMs } : {}), ...trims },
      // The source clip stays attached (the normal dubbed-section shape) —
      // resize handles require it (take-only sections play via the master).
      [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
    },
    ...over,
  } as unknown as CellData
  return { cell, kind: "take", audioId: takeId }
}

const base = {
  pxPerSec: 40,
  viewStartSec: 0,
  viewEndSec: 100,
  selectedId: null,
  editable: true,
  snapEnabled: false,
  onSelect: () => {},
}

describe("TargetAudioLane — geometry", () => {
  it("chip width = the recording's duration; left = the section start by default", () => {
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} />)
    const chip = screen.getByTestId("tl-target-c1")
    expect(parseFloat(chip.style.left)).toBeCloseTo(10 * 40)
    expect(parseFloat(chip.style.width)).toBeCloseTo(4 * 40)
  })

  it("unknown duration falls back to the section width", () => {
    render(<TargetAudioLane {...base} items={[item()]} />)
    expect(parseFloat(screen.getByTestId("tl-target-c1").style.width)).toBeCloseTo(10 * 40)
  })

  it("a moved chip (target_start_ms) renders at its own start", () => {
    render(<TargetAudioLane {...base} items={[item({ metadata: { target_start_ms: 14000 } }, 4000)]} />)
    expect(parseFloat(screen.getByTestId("tl-target-c1").style.left)).toBeCloseTo(14 * 40)
  })
})

describe("TargetAudioLane — overflow warnings", () => {
  it("no overflow → data-overflow=none", () => {
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "none")
  })

  it("a long dub past the section end → soft (amber)", () => {
    render(<TargetAudioLane {...base} items={[item({}, 12000)]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "soft")
  })

  it("a dub reaching the NEXT section's chip → overlap (red, both will sound)", () => {
    const first = item({}, 12500) // [10, 22.5]
    const second = item({ startTime: 20, endTime: 30 } as Partial<CellData>, 4000, "c2") // chip at 20
    render(<TargetAudioLane {...base} items={[first, second]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "overlap")
    expect(screen.getByTestId("tl-target-c2")).toHaveAttribute("data-overflow", "none")
  })

  it("BLAME THE TRESPASSER: a chip slid back under the previous dub carries the warning; the in-bounds previous chip stays clean", () => {
    const first = item({}, 8000) // [10, 18] — inside its own section (10–20)
    // c2's section is 20–30; slid back to 16, its head under c1's tail.
    const second = item(
      { startTime: 20, endTime: 30, metadata: { target_start_ms: 16000 } } as Partial<CellData>,
      6000,
      "c2",
    )
    render(<TargetAudioLane {...base} items={[first, second]} />)
    expect(screen.getByTestId("tl-target-c2")).toHaveAttribute("data-overflow", "overlap")
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "none")
  })

  it("a backward slide into EMPTY slack (short previous dub) warns nobody", () => {
    const first = item({}, 4000) // [10, 14]
    const second = item(
      { startTime: 20, endTime: 30, metadata: { target_start_ms: 16000 } } as Partial<CellData>,
      6000,
      "c2",
    ) // [16, 22] — the space between 14 and 20 was free
    render(<TargetAudioLane {...base} items={[first, second]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "none")
    expect(screen.getByTestId("tl-target-c2")).toHaveAttribute("data-overflow", "none")
  })

  it("the mover's hover shows its own overlap as a red negative number", async () => {
    const first = item({}, 8000) // tail at 18
    const second = item(
      { startTime: 20, endTime: 30, metadata: { target_start_ms: 16000 } } as Partial<CellData>,
      6000,
      "c2",
    ) // head at 16 → 2.0s under c1's tail
    renderWithTooltips(<TargetAudioLane {...base} items={[first, second]} />)
    await expectTooltip(screen.getByTestId("tl-target-c2"), /−2\.0s.*previous dub/)
    // The red paints the whole warning line (the number span inherits it).
    expect(
      screen.getByTestId("tl-target-c2-tip-overlap-head").parentElement?.className,
    ).toContain("text-red")
  })

  it("the head-overlap NUMBER is masked when the previous chip's width is a guess (SUB-48)", async () => {
    const first = item() // no duration → fallback width, guessed tail at 20
    const second = item(
      { startTime: 20, endTime: 30, metadata: { target_start_ms: 16000 } } as Partial<CellData>,
      6000,
      "c2",
    ) // head at 16, under c1's GUESSED tail
    renderWithTooltips(<TargetAudioLane {...base} items={[first, second]} />)
    // The warning prose still fires — but no number derived from a guess.
    await expectTooltip(screen.getByTestId("tl-target-c2"), /Overlaps the previous dub/)
    expect(screen.queryByTestId("tl-target-c2-tip-overlap-head")).toBeNull()
  })

  it("the overlong chip's hover states the tail overlap as a red negative number", async () => {
    const first = item({}, 12500) // [10, 22.5] over c2's chip at 20 → −2.5s
    const second = item({ startTime: 20, endTime: 30 } as Partial<CellData>, 4000, "c2")
    renderWithTooltips(<TargetAudioLane {...base} items={[first, second]} />)
    await expectTooltip(screen.getByTestId("tl-target-c1"), /−2\.5s.*next dub/)
    expect(
      screen.getByTestId("tl-target-c1-tip-overlap").parentElement?.className,
    ).toContain("text-red")
  })

  it("round 7: the earlier (overlong) chip paints OVER the following chip", () => {
    const first = item({}, 12500)
    const second = item({ startTime: 20, endTime: 30 } as Partial<CellData>, 4000, "c2")
    render(<TargetAudioLane {...base} items={[first, second]} />)
    const z1 = Number(screen.getByTestId("tl-target-c1").style.zIndex)
    const z2 = Number(screen.getByTestId("tl-target-c2").style.zIndex)
    expect(z1).toBeGreaterThan(z2)
  })

  it("round 7: a selected chip is topmost regardless of order", () => {
    const first = item({}, 12500)
    const second = item({ startTime: 20, endTime: 30 } as Partial<CellData>, 4000, "c2")
    render(<TargetAudioLane {...base} selectedId="c2" items={[first, second]} />)
    const z1 = Number(screen.getByTestId("tl-target-c1").style.zIndex)
    const z2 = Number(screen.getByTestId("tl-target-c2").style.zIndex)
    expect(z2).toBeGreaterThan(z1)
  })
})

describe("TargetAudioLane — trimmed geometry (round 7)", () => {
  it("a head-trimmed chip draws from anchor + trimStart at the trimmed length", () => {
    render(<TargetAudioLane {...base} items={[item({}, 4000, "c1", { trimStartMs: 1000 })]} />)
    const chip = screen.getByTestId("tl-target-c1")
    expect(parseFloat(chip.style.left)).toBeCloseTo(11 * 40) // 10 + 1
    expect(parseFloat(chip.style.width)).toBeCloseTo(3 * 40) // 4 - 1
  })

  it("END-based bounds: a chip can slide back into the previous section's space", () => {
    const onRetimeTarget = vi.fn()
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} onRetimeTarget={onRetimeTarget} />)
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 320 }) // −2s → start 8, before section start 10
    fireEvent.pointerUp(window, { clientX: 320 })
    const [, anchor] = onRetimeTarget.mock.calls[0] as [string, number]
    expect(anchor).toBeCloseTo(8)
  })

  it("END-based bounds: the chip's END may not move before its section's start", () => {
    const onRetimeTarget = vi.fn()
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} onRetimeTarget={onRetimeTarget} />)
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 0 }) // −10s → way past the bound
    fireEvent.pointerUp(window, { clientX: 0 })
    const [, anchor] = onRetimeTarget.mock.calls[0] as [string, number]
    // len 4, section 10–20, ε 0.05 → floor = 10 + 0.05 − 4: a sliver of the
    // chip's tail stays in-section.
    expect(anchor).toBeCloseTo(6.05)
  })

  it("the drag stops at the PREVIOUS chip's start — no leapfrogging another chip (2026-08-06)", () => {
    const onRetimeTarget = vi.fn()
    const first = item({}, 4000) // chip [10, 14] in section 10–20
    const second = item({ startTime: 20, endTime: 30 } as Partial<CellData>, 8000, "c2") // [20, 28]
    render(<TargetAudioLane {...base} items={[first, second]} onRetimeTarget={onRetimeTarget} />)
    const chip = screen.getByTestId("tl-target-c2")
    fireEvent.pointerDown(chip, { clientX: 800, pointerId: 1 }) // start 20s
    fireEvent.pointerMove(window, { clientX: 0 }) // −20s → way past everything
    fireEvent.pointerUp(window, { clientX: 0 })
    const [, anchor] = onRetimeTarget.mock.calls[0] as [string, number]
    // End-based floor would allow 12.05 (20.05 − 8), but the previous chip
    // starts at 10... the binding bound here is the section floor. Use a
    // longer chip to make the PREV bound the binding one:
    expect(anchor).toBeCloseTo(12.05)
  })

  it("…and with a chip long enough to reach it, the previous chip's start IS the floor", () => {
    const onRetimeTarget = vi.fn()
    const first = item({}, 4000) // chip [10, 14]
    const second = item({ startTime: 20, endTime: 30 } as Partial<CellData>, 15000, "c2") // 15s long
    render(<TargetAudioLane {...base} items={[first, second]} onRetimeTarget={onRetimeTarget} />)
    const chip = screen.getByTestId("tl-target-c2")
    fireEvent.pointerDown(chip, { clientX: 800, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 0 })
    fireEvent.pointerUp(window, { clientX: 0 })
    const [, anchor] = onRetimeTarget.mock.calls[0] as [string, number]
    // End-based floor would be 20.05 − 15 = 5.05 — but the previous chip
    // starts at 10, and that wins: never leapfrog a neighbour.
    expect(anchor).toBeCloseTo(10)
  })

  it("…and the FORWARD drag stops at the NEXT chip's start — the rule is symmetric (2026-08-06)", () => {
    const onRetimeTarget = vi.fn()
    const first = item({}, 4000) // chip [10, 14] in section 10–20
    // c2 slid back into c1's section: starts at 16.
    const second = item(
      { startTime: 20, endTime: 30, metadata: { target_start_ms: 16000 } } as Partial<CellData>,
      6000,
      "c2",
    )
    render(<TargetAudioLane {...base} items={[first, second]} onRetimeTarget={onRetimeTarget} />)
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 400, pointerId: 1 }) // start 10s
    fireEvent.pointerMove(window, { clientX: 800 }) // +10s → would start at 20
    fireEvent.pointerUp(window, { clientX: 800 })
    const [, anchor] = onRetimeTarget.mock.calls[0] as [string, number]
    // The section ceiling alone would allow 19.95 — past c2's start at 16,
    // leapfrogging it. The next chip's start is the binding ceiling.
    expect(anchor).toBeCloseTo(16)
  })

  it("the LEFT trim handle also stops at the previous chip's start (2026-08-06)", () => {
    const onTrimTarget = vi.fn()
    const first = item({ metadata: { target_start_ms: 14000 } } as Partial<CellData>, 4000) // [14, 18]
    // c2: anchor 13, head-trimmed 2s → audible [15, 19], legally after c1's start.
    const second = item(
      { startTime: 20, endTime: 30, metadata: { target_start_ms: 13000 } } as Partial<CellData>,
      6000,
      "c2",
      { trimStartMs: 2000 },
    )
    render(<TargetAudioLane {...base} items={[first, second]} onTrimTarget={onTrimTarget} />)
    const handle = screen.getByTestId("tl-target-c2-handle-l")
    fireEvent.pointerDown(handle, { clientX: 600, pointerId: 1 }) // audible start 15s
    fireEvent.pointerMove(window, { clientX: 400 }) // −5s → would un-trim to 10
    fireEvent.pointerUp(window, { clientX: 400 })
    const [, , trims] = onTrimTarget.mock.calls[0] as [string, string, { trimStartMs?: number }]
    // The clip could un-trim to its anchor at 13 — but that would put its
    // audible start before c1's start at 14. The neighbour's start wins.
    expect(trims.trimStartMs).toBe(1000)
  })

  it("END-based bounds: the stored anchor can never go below file zero", () => {
    const onRetimeTarget = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[item({}, 12000, "c1", { trimStartMs: 1000 })]}
        onRetimeTarget={onRetimeTarget}
      />,
    )
    // Visual [11, 22] (anchor 10, trimmed head). End-bound would allow start
    // −0.95, but audible start ≥ trimStart keeps the anchor ≥ 0.
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 440, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 0 }) // −11s
    fireEvent.pointerUp(window, { clientX: 0 })
    const [, anchor] = onRetimeTarget.mock.calls[0] as [string, number]
    expect(anchor).toBeCloseTo(0)
  })

  it("the left trim handle follows a chip that begins before its section", () => {
    const onTrimTarget = vi.fn()
    // c1's section is 20–30; the chip slid back: anchor 16, head-trimmed to 17.
    render(
      <TargetAudioLane
        {...base}
        items={[
          item(
            { startTime: 20, endTime: 30, metadata: { target_start_ms: 16000 } } as Partial<CellData>,
            6000,
            "c1",
            { trimStartMs: 1000 },
          ),
        ]}
        onTrimTarget={onTrimTarget}
      />,
    )
    const handle = screen.getByTestId("tl-target-c1-handle-l")
    fireEvent.pointerDown(handle, { clientX: 680, pointerId: 1 }) // visual start 17s
    fireEvent.pointerMove(window, { clientX: 600 }) // toward 15s → clamps at the ANCHOR (16), not section start (20)
    fireEvent.pointerUp(window, { clientX: 600 })
    const [, , trims] = onTrimTarget.mock.calls[0] as [string, string, { trimStartMs?: number }]
    expect(trims.trimStartMs).toBeUndefined() // back at the clip edge = cleared
  })

  it("at EXACT start equality the covered chip collapses to a reachable sliver", () => {
    const first = item({}, 12000) // [10, 22]
    const second = item(
      { startTime: 20, endTime: 30, metadata: { target_start_ms: 10000 } } as Partial<CellData>,
      6000,
      "c2",
    ) // slid to exactly 10 — same start as c1
    render(<TargetAudioLane {...base} items={[first, second]} />)
    const c1 = screen.getByTestId("tl-target-c1")
    expect(c1).toHaveAttribute("data-truncated", "true")
    expect(parseFloat(c1.style.width)).toBe(10) // the min-width sliver
  })

  it("moving a head-trimmed chip commits the ANCHOR, not the visual left", () => {
    const onRetimeTarget = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[item({}, 4000, "c1", { trimStartMs: 1000 })]}
        onRetimeTarget={onRetimeTarget}
      />,
    )
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 260 }) // +4s → visual left 15
    fireEvent.pointerUp(window, { clientX: 260 })
    const [, anchor] = onRetimeTarget.mock.calls[0] as [string, number]
    expect(anchor).toBeCloseTo(14) // left 15 − trimStart 1
  })
})

describe("TargetAudioLane — resize-as-trim (round 7)", () => {
  it("dragging the RIGHT handle commits a tail trim (complete trim state)", () => {
    const onTrimTarget = vi.fn()
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} onTrimTarget={onTrimTarget} />)
    const handle = screen.getByTestId("tl-target-c1-handle-r")
    fireEvent.pointerDown(handle, { clientX: 560, pointerId: 1 }) // chip end at 14s = 560px
    fireEvent.pointerMove(window, { clientX: 520 }) // −1s → end 13
    fireEvent.pointerUp(window, { clientX: 520 })
    expect(onTrimTarget).toHaveBeenCalledTimes(1)
    const [cellId, audioId, trims] = onTrimTarget.mock.calls[0] as [string, string, { trimStartMs?: number; trimEndMs?: number }]
    expect(cellId).toBe("c1")
    expect(audioId).toContain("audio-c1-")
    expect(trims.trimEndMs).toBe(3000) // end 13 − anchor 10
    expect(trims.trimStartMs).toBeUndefined()
  })

  it("dragging the LEFT handle commits a head trim; the right edge stays put", () => {
    const onTrimTarget = vi.fn()
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} onTrimTarget={onTrimTarget} />)
    const handle = screen.getByTestId("tl-target-c1-handle-l")
    fireEvent.pointerDown(handle, { clientX: 400, pointerId: 1 }) // chip start 10s = 400px
    fireEvent.pointerMove(window, { clientX: 440 }) // +1s → start 11
    fireEvent.pointerUp(window, { clientX: 440 })
    const [, , trims] = onTrimTarget.mock.calls[0] as [string, string, { trimStartMs?: number; trimEndMs?: number }]
    expect(trims.trimStartMs).toBe(1000)
    expect(trims.trimEndMs).toBeUndefined() // untouched tail stays cleared
  })

  it("resizing back to the clip edge CLEARS the trim key", () => {
    const onTrimTarget = vi.fn()
    render(
      <TargetAudioLane {...base} items={[item({}, 4000, "c1", { trimEndMs: 3000 })]} onTrimTarget={onTrimTarget} />,
    )
    const handle = screen.getByTestId("tl-target-c1-handle-r")
    fireEvent.pointerDown(handle, { clientX: 520, pointerId: 1 }) // end at 13s
    fireEvent.pointerMove(window, { clientX: 560 }) // back out to 14 = full duration
    fireEvent.pointerUp(window, { clientX: 560 })
    const [, , trims] = onTrimTarget.mock.calls[0] as [string, string, { trimStartMs?: number; trimEndMs?: number }]
    expect(trims.trimEndMs).toBeUndefined()
  })

  it("no handles on fallback-width (unknown-duration) chips", () => {
    render(<TargetAudioLane {...base} items={[item()]} onTrimTarget={() => {}} />)
    expect(screen.queryByTestId("tl-target-c1-handle-r")).toBeNull()
  })

  it("no handles on take-only sections (the master plays the take)", () => {
    const takeOnly = item({}, 4000)
    delete (takeOnly.cell.attachments as Record<string, unknown>)[SOURCE_ID]
    render(<TargetAudioLane {...base} items={[takeOnly]} onTrimTarget={() => {}} />)
    expect(screen.queryByTestId("tl-target-c1-handle-r")).toBeNull()
  })
})

describe("TargetAudioLane — interaction", () => {
  it("clean click selects and seeks", () => {
    const onSelect = vi.fn()
    const onSeek = vi.fn()
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} onSelect={onSelect} onSeek={onSeek} />)
    fireEvent.click(screen.getByTestId("tl-target-c1"))
    expect(onSelect).toHaveBeenCalledWith("c1")
    expect(onSeek).toHaveBeenCalledWith("c1")
  })

  it("dragging commits the new start (clamped into the section) and suppresses the seek", () => {
    const onRetimeTarget = vi.fn()
    const onSeek = vi.fn()
    render(
      <TargetAudioLane {...base} items={[item({}, 4000)]} onRetimeTarget={onRetimeTarget} onSeek={onSeek} />,
    )
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 260 }) // +160px = +4s → start 14
    fireEvent.pointerUp(window, { clientX: 260 })
    fireEvent.click(chip)
    expect(onRetimeTarget).toHaveBeenCalledTimes(1)
    const [, start] = onRetimeTarget.mock.calls[0] as [string, number]
    expect(start).toBeCloseTo(14)
    expect(onSeek).not.toHaveBeenCalled()
  })

  it("a drag past the section end clamps the start inside the section", () => {
    const onRetimeTarget = vi.fn()
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} onRetimeTarget={onRetimeTarget} />)
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 1100 }) // +25s → way past section end 20
    fireEvent.pointerUp(window, { clientX: 1100 })
    const [, start] = onRetimeTarget.mock.calls[0] as [string, number]
    expect(start).toBeCloseTo(20 - 0.05)
  })

  it("snap ON: a near-neighbor edge magnets the chip flush", () => {
    const onRetimeTarget = vi.fn()
    const first = item({}, 4000) // section [10,20], chip [10,14]
    const second = item({ startTime: 20, endTime: 30 } as Partial<CellData>, 4000, "c2")
    render(
      <TargetAudioLane {...base} snapEnabled items={[first, second]} onRetimeTarget={onRetimeTarget} />,
    )
    const chip = screen.getByTestId("tl-target-c1")
    // +236px = +5.9s → chip [15.9, 19.9]; end 19.9 is within 0.2s of c2's
    // chip start (20) → snaps to end=20 → start 16.
    fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 336 })
    fireEvent.pointerUp(window, { clientX: 336 })
    const [, start] = onRetimeTarget.mock.calls[0] as [string, number]
    expect(start).toBeCloseTo(16)
  })

  it("not editable → no drag commit", () => {
    const onRetimeTarget = vi.fn()
    render(
      <TargetAudioLane {...base} editable={false} items={[item({}, 4000)]} onRetimeTarget={onRetimeTarget} />,
    )
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 260 })
    fireEvent.pointerUp(window, { clientX: 260 })
    expect(onRetimeTarget).not.toHaveBeenCalled()
  })
})

describe("TargetAudioLane — windowing", () => {
  it("windows by the CHIP span, not the section", () => {
    // Section [10,20] but chip moved to [18,22] — with a view of [21,40] the
    // chip still renders (its tail is inside the window).
    render(
      <TargetAudioLane
        {...base}
        viewStartSec={21}
        viewEndSec={40}
        items={[item({ metadata: { target_start_ms: 18000 } }, 4000)]}
      />,
    )
    expect(screen.getByTestId("tl-target-c1")).toBeInTheDocument()
  })
})

// Keep the round-5 basics honest too.
describe("TargetAudioLane — kinds", () => {
  it("take vs generated icons via data-kind", () => {
    const gen: TargetAudioItem = {
      ...item({ selectedAudioId: undefined, selectedGeneratedVoiceAudioId: "audio-c1-1700000001-gen.wav", attachments: { "audio-c1-1700000001-gen.wav": { type: "audio", url: "frontier-audio://gen", durationMs: 2000 } } } as Partial<CellData>),
      kind: "generated",
      audioId: "audio-c1-1700000001-gen.wav",
    }
    render(<TargetAudioLane {...base} items={[gen]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-kind", "generated")
  })
})

// Round 8b (Sam): a corner mic button on every chip — record without the trip
// to the detail pane. It must never trigger the chip's own click (seek) or
// start a drag.
describe("TargetAudioLane — corner record button (round 8b)", () => {
  it("opens the recording modal for THAT cell and selects it, without seeking", () => {
    const onOpenRecording = vi.fn()
    const onSelect = vi.fn()
    const onSeek = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[item({}, 4000)]}
        onSelect={onSelect}
        onSeek={onSeek}
        onOpenRecording={onOpenRecording}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-target-c1-record"))
    expect(onOpenRecording).toHaveBeenCalledWith("c1")
    expect(onSelect).toHaveBeenCalledWith("c1")
    expect(onSeek).not.toHaveBeenCalled()
  })

  it("hidden when the lane is read-only or no handler is wired", () => {
    const { rerender } = render(
      <TargetAudioLane {...base} items={[item({}, 4000)]} editable={false} onOpenRecording={vi.fn()} />,
    )
    expect(screen.queryByTestId("tl-target-c1-record")).toBeNull()
    rerender(<TargetAudioLane {...base} items={[item({}, 4000)]} />)
    expect(screen.queryByTestId("tl-target-c1-record")).toBeNull()
  })

  it("hidden on chips too narrow to host it", () => {
    // 0.5s at 40 px/s = 20px < the 28px floor.
    render(<TargetAudioLane {...base} items={[item({}, 500)]} onOpenRecording={vi.fn()} />)
    expect(screen.queryByTestId("tl-target-c1-record")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SUB-48 — honest geometry: nothing is buried, nothing lies about its length,
// and a queued clip says it is still saving.
// ---------------------------------------------------------------------------

describe("TargetAudioLane — buried chips stay reachable (SUB-48)", () => {
  // Sam's exact repro: a long take, then another long take, then a short one.
  // The third chip sat entirely underneath the second and could not be clicked.
  const longLongShort = () => [
    item({ startTime: 10, endTime: 20 }, 20_000, "c1"), // 10 → 30, buries c2
    item({ startTime: 20, endTime: 30 } as Partial<CellData>, 20_000, "c2"), // 20 → 40, buries c3
    item({ startTime: 30, endTime: 40 } as Partial<CellData>, 2_000, "c3"), // 30 → 32
  ]

  it("an overlong chip is PAINTED up to the next chip, not over it", () => {
    render(<TargetAudioLane {...base} items={longLongShort()} />)
    // c1 runs to 30s but c2 starts at 20s → painted 10s wide, not 20s.
    expect(parseFloat(screen.getByTestId("tl-target-c1").style.width)).toBeCloseTo(10 * 40)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-truncated", "true")
  })

  it("every chip in the long/long/short pile has real estate of its own", () => {
    render(<TargetAudioLane {...base} items={longLongShort()} />)
    const left = (id: string) => parseFloat(screen.getByTestId(id).style.left)
    const width = (id: string) => parseFloat(screen.getByTestId(id).style.width)
    // No chip's painted box swallows the next chip's start.
    expect(left("tl-target-c1") + width("tl-target-c1")).toBeLessThanOrEqual(left("tl-target-c2") + 0.5)
    expect(left("tl-target-c2") + width("tl-target-c2")).toBeLessThanOrEqual(left("tl-target-c3") + 0.5)
    // …and the short one that used to be completely hidden has width to click.
    expect(width("tl-target-c3")).toBeGreaterThan(10)
  })

  it("the truncated edge carries a runs-over marker toned by the collision", () => {
    render(<TargetAudioLane {...base} items={longLongShort()} />)
    const marker = screen.getByTestId("tl-target-c1-overflow")
    expect(marker).toBeInTheDocument()
    // c1 overlaps the next dub outright → red, not amber.
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "overlap")
    expect(marker.className).toContain("red")
  })

  it("SELECTING an overlong chip must not re-bury the next one (selection is sticky)", () => {
    // Clicking the long chip is the first thing a user does. If selection
    // expanded it, the neighbour would sit underneath it for as long as it
    // stayed selected — reinstating the exact bug this fixes.
    render(<TargetAudioLane {...base} items={longLongShort()} selectedId="c1" />)
    expect(parseFloat(screen.getByTestId("tl-target-c1").style.width)).toBeCloseTo(10 * 40)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-truncated", "true")
  })

  it("hovering restores full length too, then releases it", () => {
    render(<TargetAudioLane {...base} items={longLongShort()} />)
    const chip = screen.getByTestId("tl-target-c1")
    fireEvent.pointerEnter(chip)
    expect(parseFloat(chip.style.width)).toBeCloseTo(20 * 40)
    fireEvent.pointerLeave(chip)
    expect(parseFloat(chip.style.width)).toBeCloseTo(10 * 40)
  })

  it("a chip with no chip after it is never truncated", () => {
    render(<TargetAudioLane {...base} items={[item({}, 20_000)]} />)
    expect(screen.getByTestId("tl-target-c1")).not.toHaveAttribute("data-truncated")
    expect(parseFloat(screen.getByTestId("tl-target-c1").style.width)).toBeCloseTo(20 * 40)
  })
})

describe("TargetAudioLane — unknown length is visible (SUB-48)", () => {
  it("a clip with no measured duration is dashed and marked, not silently section-width", () => {
    render(<TargetAudioLane {...base} items={[item()]} />) // no durationMs
    const chip = screen.getByTestId("tl-target-c1")
    expect(chip).toHaveAttribute("data-unknown-length", "true")
    expect(chip.className).toContain("border-dashed")
    expect(screen.getByTestId("tl-target-c1-unknown-length")).toBeInTheDocument()
  })

  it("a measured clip carries none of that", () => {
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} />)
    const chip = screen.getByTestId("tl-target-c1")
    expect(chip).not.toHaveAttribute("data-unknown-length")
    expect(chip.className).not.toContain("border-dashed")
    expect(screen.queryByTestId("tl-target-c1-unknown-length")).toBeNull()
  })
})

describe("TargetAudioLane — saving indicator (SUB-48)", () => {
  function pendingItem(): TargetAudioItem {
    const it = item({}, 4000)
    const takeId = it.audioId
    const cell = {
      ...it.cell,
      attachments: {
        ...it.cell.attachments,
        [takeId]: { ...it.cell.attachments![takeId], pendingSync: true },
      },
    } as unknown as CellData
    return { ...it, cell }
  }

  it("a clip whose event is still queued shows the saving glyph", () => {
    render(<TargetAudioLane {...base} items={[pendingItem()]} />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-pending-sync", "true")
    expect(screen.getByTestId("tl-target-c1-saving")).toBeInTheDocument()
  })

  it("a synced clip shows nothing extra", () => {
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} />)
    expect(screen.getByTestId("tl-target-c1")).not.toHaveAttribute("data-pending-sync")
    expect(screen.queryByTestId("tl-target-c1-saving")).toBeNull()
  })
})

describe("TargetAudioLane — missing badge + loading spinner (2026-08-05)", () => {
  it("a definitively missing dub shows the red badge and says so on hover", async () => {
    renderWithTooltips(
      <TargetAudioLane {...base} items={[item({}, 4000)]} missingCellIds={new Set(["c1"])} />,
    )
    const chip = screen.getByTestId("tl-target-c1")
    expect(chip).toHaveAttribute("data-missing", "true")
    expect(screen.getByTestId("tl-target-c1-missing")).toBeInTheDocument()
    await expectTooltip(chip, /This clip's audio is missing\./)
  })

  it("the verse being waited on shows the loading spinner", () => {
    render(<TargetAudioLane {...base} items={[item({}, 4000)]} loadingCellId="c1" />)
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-loading", "true")
    expect(screen.getByTestId("tl-target-c1-loading")).toBeInTheDocument()
  })

  it("the corner is a PRIORITY slot: missing beats loading beats saving — one glyph max", () => {
    const it_ = item({}, 4000)
    const takeId = it_.audioId
    const pendingCell = {
      ...it_.cell,
      attachments: {
        ...it_.cell.attachments,
        [takeId]: { ...it_.cell.attachments![takeId], pendingSync: true },
      },
    } as unknown as CellData
    render(
      <TargetAudioLane
        {...base}
        items={[{ ...it_, cell: pendingCell }]}
        loadingCellId="c1"
        missingCellIds={new Set(["c1"])}
      />,
    )
    expect(screen.getByTestId("tl-target-c1-missing")).toBeInTheDocument()
    expect(screen.queryByTestId("tl-target-c1-loading")).toBeNull()
    expect(screen.queryByTestId("tl-target-c1-saving")).toBeNull()
  })

  it("any left glyph pushes the hover mic button to the wider threshold", () => {
    // 1s at 40px/s = 40px wide: enough for the mic alone (28) but not beside
    // a corner glyph (46) — same arbitration the saving glyph pinned.
    render(
      <TargetAudioLane
        {...base}
        items={[item({}, 1000)]}
        missingCellIds={new Set(["c1"])}
        onOpenRecording={() => {}}
      />,
    )
    expect(screen.queryByTestId("tl-target-c1-record")).toBeNull()
  })
})

describe("TargetAudioLane — truncation edge cases (SUB-48)", () => {
  it("a chip moved BEFORE its neighbour keeps its full width (no sliver)", () => {
    // c2 is dragged back to 5s, ahead of c1 at 10s. Clamping c2 to "the next
    // chip's start" would collapse it to nothing; it buries no one, so it
    // must draw in full.
    const moved = item({ startTime: 0, endTime: 40, metadata: { target_start_ms: 5000 } } as Partial<CellData>, 4000, "c2")
    render(<TargetAudioLane {...base} items={[moved, item({}, 4000)]} />)
    expect(parseFloat(screen.getByTestId("tl-target-c2").style.width)).toBeCloseTo(4 * 40)
    expect(screen.getByTestId("tl-target-c2")).not.toHaveAttribute("data-truncated")
  })

  it("a chip that ends exactly at the next chip's start is not marked truncated", () => {
    const first = item({ startTime: 10, endTime: 20 }, 10_000, "c1") // 10 → 20
    const second = item({ startTime: 20, endTime: 30 } as Partial<CellData>, 4000, "c2") // starts at 20
    render(<TargetAudioLane {...base} items={[first, second]} />)
    expect(screen.getByTestId("tl-target-c1")).not.toHaveAttribute("data-truncated")
    expect(parseFloat(screen.getByTestId("tl-target-c1").style.width)).toBeCloseTo(10 * 40)
  })
})

describe("TargetAudioLane — corner affordances never collide (SUB-48)", () => {
  function pendingNarrow(durationMs: number): TargetAudioItem {
    const it = item({ startTime: 10, endTime: 20 }, durationMs)
    const cell = {
      ...it.cell,
      attachments: {
        ...it.cell.attachments,
        [it.audioId]: { ...it.cell.attachments![it.audioId], pendingSync: true },
      },
    } as unknown as CellData
    return { ...it, cell }
  }

  it("a narrow queued chip hides the mic button rather than stacking it on the saving glyph", () => {
    // 1s at 40px/s = 40px: wide enough for the mic button's old threshold,
    // too narrow to hold both it and the saving glyph.
    render(<TargetAudioLane {...base} items={[pendingNarrow(1000)]} onOpenRecording={vi.fn()} />)
    expect(screen.getByTestId("tl-target-c1-saving")).toBeInTheDocument()
    expect(screen.queryByTestId("tl-target-c1-record")).toBeNull()
  })

  it("a wide queued chip shows both", () => {
    render(<TargetAudioLane {...base} items={[pendingNarrow(4000)]} onOpenRecording={vi.fn()} />)
    expect(screen.getByTestId("tl-target-c1-saving")).toBeInTheDocument()
    expect(screen.getByTestId("tl-target-c1-record")).toBeInTheDocument()
  })

  it("a not-yet-queued narrow chip keeps the mic button at its normal threshold", () => {
    render(<TargetAudioLane {...base} items={[item({ startTime: 10, endTime: 20 }, 1000)]} onOpenRecording={vi.fn()} />)
    expect(screen.getByTestId("tl-target-c1-record")).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// SUB-51 — a record button waiting in the empty space of an un-dubbed section
// ---------------------------------------------------------------------------

describe("TargetAudioLane — empty-slot record button (SUB-51)", () => {
  const emptyCell = (id: string, startTime = 30, endTime = 36): CellData =>
    ({ id, fileId: "f1", medium: "media", startTime, endTime, attachments: {} }) as unknown as CellData

  it("offers a record button spanning each dub-free section", () => {
    render(
      <TargetAudioLane
        {...base}
        items={[item({}, 4000)]}
        emptyCells={[emptyCell("c9")]}
        onOpenRecording={vi.fn()}
      />,
    )
    const slot = screen.getByTestId("tl-target-empty-c9")
    expect(parseFloat(slot.style.left)).toBeCloseTo(30 * 40)
    expect(parseFloat(slot.style.width)).toBeCloseTo(6 * 40)
    expect(screen.getByTestId("tl-target-empty-c9-record")).toBeInTheDocument()
  })

  it("opens the recorder on that cell and selects it, without seeking", () => {
    const onOpenRecording = vi.fn()
    const onSelect = vi.fn()
    const onSeek = vi.fn()
    render(
      <TargetAudioLane
        {...base}
        items={[]}
        emptyCells={[emptyCell("c9")]}
        onSelect={onSelect}
        onSeek={onSeek}
        onOpenRecording={onOpenRecording}
      />,
    )
    fireEvent.click(screen.getByTestId("tl-target-empty-c9-record"))
    expect(onOpenRecording).toHaveBeenCalledWith("c9")
    expect(onSelect).toHaveBeenCalledWith("c9")
    expect(onSeek).not.toHaveBeenCalled()
  })

  it("is absent when read-only, unwired, or the section is too narrow to hit", () => {
    const { rerender } = render(
      <TargetAudioLane {...base} items={[]} emptyCells={[emptyCell("c9")]} editable={false} onOpenRecording={vi.fn()} />,
    )
    expect(screen.queryByTestId("tl-target-empty-c9")).toBeNull()

    rerender(<TargetAudioLane {...base} items={[]} emptyCells={[emptyCell("c9")]} />)
    expect(screen.queryByTestId("tl-target-empty-c9")).toBeNull()

    // 0.5s at 40px/s = 20px — no room for a 28px button.
    rerender(
      <TargetAudioLane {...base} items={[]} emptyCells={[emptyCell("c9", 30, 30.5)]} onOpenRecording={vi.fn()} />,
    )
    expect(screen.queryByTestId("tl-target-empty-c9")).toBeNull()
  })

  it("uses a testid distinct from a real chip's, so a dub-free cell still has no chip", () => {
    render(<TargetAudioLane {...base} items={[]} emptyCells={[emptyCell("c9")]} onOpenRecording={vi.fn()} />)
    expect(screen.queryByTestId("tl-target-c9")).toBeNull()
    expect(screen.getByTestId("tl-target-empty-c9")).toBeInTheDocument()
  })

  it("skips sections scrolled out of view", () => {
    render(
      <TargetAudioLane
        {...base}
        viewStartSec={0}
        viewEndSec={20}
        items={[]}
        emptyCells={[emptyCell("c9", 40, 46)]}
        onOpenRecording={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("tl-target-empty-c9")).toBeNull()
  })
})
