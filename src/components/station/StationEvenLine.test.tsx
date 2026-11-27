// AQU-2664 (boards 72, 73): the Station's one evening-out line under the
// transport, its Clear and "Even out again", and the (i) row for Even out.
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { StationEvenLine } from "./StationEvenLine"
import { StationHeader } from "./StationPanel"
import type { StationHost, StationTake } from "./station-host"

function makeTake(over: Record<string, unknown> = {}): StationTake {
  const att = { url: "frontier-audio://t2.webm", type: "audio", label: "Take 2", validators: [], validatorCount: 0, ...over }
  return {
    fileId: "f1",
    cell: { id: "c694", attachments: { "t2.webm": att } } as unknown as StationTake["cell"],
    att: att as StationTake["att"],
  }
}
const target = { fileId: "f1", cellId: "c694", audioId: "t2.webm" }

function host(over: Partial<StationHost> = {}): StationHost {
  return {
    lineName: () => "694",
    evenOut: vi.fn(async () => null),
    clearEvenOut: vi.fn(async () => ({ cleared: 1, gone: 0, failed: 0, stepId: "s" })),
    ...over,
  } as unknown as StationHost
}

const EVENED = { loudnessLufs: -26.2, truePeakDb: -12, evenTargetLufs: -16 }

describe("the Station's evening-out line", () => {
  it("is not there on a take that was never evened", () => {
    render(<StationEvenLine host={host()} take={makeTake()} target={target} ownDb={0} editable />)
    expect(screen.queryByTestId("station-even-line")).toBeNull()
  })

  it("reads “≈ Evened +10.2 dB · your volume −2 dB · Clear”", () => {
    render(<StationEvenLine host={host()} take={makeTake(EVENED)} target={target} ownDb={-2} editable />)
    const line = screen.getByTestId("station-even-line")
    expect(line.textContent).toBe("Evened +10.2 dB·your volume −2 dB·Clear")
    expect(screen.getByTestId("station-even-amount").className).toContain("text-sky-700")
  })

  it("is amber on a take that couldn't go all the way", () => {
    render(<StationEvenLine host={host()} take={makeTake({ loudnessLufs: -30.4, truePeakDb: -14, evenTargetLufs: -16 })} target={target} ownDb={0} editable />)
    expect(screen.getByTestId("station-even-amount").textContent).toBe("Evened +12.0 dB, not all the way")
    expect(screen.getByTestId("station-even-amount").className).toContain("text-amber-700")
    expect(screen.getByTestId("station-even-line").textContent).toContain("your volume 0 dB")
  })

  it("Clear takes off only the evening out, and the line stays with “Even out again”", async () => {
    const h = host()
    const { rerender } = render(<StationEvenLine host={h} take={makeTake(EVENED)} target={target} ownDb={-2} editable />)
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() => expect(h.clearEvenOutTake ?? h.clearEvenOut).toHaveBeenCalled())
    expect(h.clearEvenOut).toHaveBeenCalledWith([{ cellId: "c694", audioId: "t2.webm" }])
    // The take comes back from the workspace without its target.
    rerender(<StationEvenLine host={h} take={makeTake({ ...EVENED, evenTargetLufs: null })} target={target} ownDb={-2} editable />)
    expect(screen.getByTestId("station-even-line").textContent).toBe("Not evened·your volume −2 dB·Even out again")
    fireEvent.click(screen.getByRole("button", { name: "Even out again" }))
    expect(h.evenOut).toHaveBeenCalledWith([{ cellId: "c694", audioId: "t2.webm" }])
  })

  it("names the take, its line and its volume for the clear's toast, when the workspace offers one", async () => {
    const clearEvenOutTake = vi.fn(async () => ({ cleared: 1, gone: 0, failed: 0, stepId: "s" }))
    render(<StationEvenLine host={host({ clearEvenOutTake })} take={makeTake(EVENED)} target={target} ownDb={-2} editable />)
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() => expect(clearEvenOutTake).toHaveBeenCalledWith("c694", "t2.webm", { take: "Take 2", line: "694", volume: "−2 dB" }))
  })

  it("offers no links to someone who may not change the take", () => {
    render(<StationEvenLine host={host()} take={makeTake(EVENED)} target={target} ownDb={0} editable={false} />)
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull()
    expect(screen.getByTestId("station-even-line").textContent).toContain("Evened +10.2 dB")
  })
})

describe("the Station's (i)", () => {
  it("has a row for Even out, after Volume", () => {
    const take = makeTake(EVENED)
    const h = {
      ...host(),
      trackVars: () => ({}),
      approvalsNeeded: 1,
      voteState: () => ({ canVote: false, voted: false }),
      readTake: () => take,
      reportHistory: () => {},
    } as unknown as StationHost
    render(<StationHeader host={h} take={take} target={target} controlsInfo />)
    const terms = [...screen.getByTestId("station-controls-info").querySelectorAll("dt")].map((d) => d.textContent)
    expect(terms.indexOf("Even out")).toBe(terms.indexOf("Volume") + 1)
    expect(screen.getByTestId("station-controls-info").textContent).toContain("Comes before your volume")
  })
})

describe("the Station's own Undo (board 73C)", () => {
  it("takes back the Station's changes and a Clear, but not a run of Even out", async () => {
    const { stationStepMatch } = await import("@/lib/station/own-steps")
    const mine = stationStepMatch("c694", "t2.webm")
    expect(mine("take.gain", { cellId: "c694", audioId: "t2.webm" })).toBe(true)
    expect(mine("take.even", { cellId: "c694", audioId: "t2.webm", before: -16, after: null })).toBe(true)
    expect(mine("take.even", { cellId: "c694", audioId: "t2.webm", before: null, after: -16, run: true })).toBe(false)
    expect(mine("take.gain", { cellId: "c1", audioId: "x" })).toBe(false)
  })
})
