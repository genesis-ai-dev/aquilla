// The Voice-together split dialog, redrawn on the shared waveform rectangle
// (2026-09-25): one clip, one plain split line per boundary, saved as a trim
// on each line.

import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/hooks/useCellAudio", () => ({
  useCellAudio: () => ({
    state: "ready", error: null, isPlaying: false, currentTime: 0, duration: 10,
    peaks: new Float32Array([0.2, 0.8, 0.4, 0.9]), peaksState: "ready",
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), setVolume: vi.fn(),
    setTrim: vi.fn(), requestPeaks: vi.fn(), ensureBytes: vi.fn(),
  }),
}))
const persisted: Array<Record<string, unknown>> = []
vi.mock("@/lib/audio/persist-trim", () => ({
  persistTakeTrim: (input: Record<string, unknown>) => { persisted.push(input); return Promise.resolve("e") },
}))

import { CombinedBoundaryEditor } from "./CombinedBoundaryEditor"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

const cells = [
  { id: "c1", fileId: "f1", translated: "Uno dos" },
  { id: "c2", fileId: "f1", translated: "Tres cuatro" },
] as unknown as CellData[]

function draw() {
  render(
    <CombinedBoundaryEditor
      project={{ id: "p1" } as unknown as ProjectRecord}
      fileId="f1" audioId="gen-1.wav" url="frontier-audio://gen-1.wav" voiceId="v1"
      cells={cells} username="sam" session={null} onClose={() => {}}
    />,
  )
}

beforeEach(() => { persisted.length = 0 })

describe("CombinedBoundaryEditor", () => {
  it("draws the clip as the shared rectangle with one plain split line", () => {
    draw()
    expect(screen.getByTestId("boundary-waveform-shape")).toBeInTheDocument()
    const line = screen.getByRole("slider", { name: /1/ })
    expect(line.className).toContain("cursor-ew-resize")
    // The old grip dot on top of the divider is gone.
    expect(line.querySelectorAll("div").length).toBe(1)
  })

  it("moves a split with the arrow keys and saves each line's slice as its trim", () => {
    draw()
    const line = screen.getByRole("slider", { name: /1/ })
    const before = Number(line.getAttribute("aria-valuenow"))
    fireEvent.keyDown(line, { key: "ArrowRight", shiftKey: true })
    expect(Number(screen.getByRole("slider", { name: /1/ }).getAttribute("aria-valuenow"))).toBe(before + 1)
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    expect(persisted.map((p) => p.cellId)).toEqual(["c1", "c2"])
    expect(persisted[0]).toMatchObject({ audioId: "gen-1.wav", trimStartMs: 0 })
    expect(persisted[1]).toMatchObject({ trimEndMs: 10_000 })
    expect(persisted[0].trimEndMs).toBe(persisted[1].trimStartMs)
  })
})
