// Evidence 72D: the Station's Even out line sits right under the transport,
// in the status row's place, not one empty row below it.
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { StationTransport } from "./StationTransport"
import type { StationEditor } from "./useStationEditor"

function fakeEditor(): StationEditor {
  const base: Record<string, unknown> = {
    status: "ready", playing: false, playT: 0, length: 4, trimA: 0, trimB: 4, sel: null, rate: 1, loop: false,
    view: { va: 0, vb: 4, w: 4, zoom: 1 },
  }
  return new Proxy(base, {
    get: (t, k: string) => (k in t ? t[k] : vi.fn()),
  }) as unknown as StationEditor
}

describe("the Station's status row", () => {
  it("holds the Even out line in the hint's place, right under the transport", () => {
    render(<StationTransport ed={fakeEditor()} editable calm hint="Drag across the waveform" onMessage={() => {}} lead={<span data-testid="lead">≈ Evened +8.7 dB</span>} />)
    const row = screen.getByTestId("station-status-row")
    expect(row.contains(screen.getByTestId("lead"))).toBe(true)
    expect(row.textContent).not.toContain("Drag across the waveform")
  })

  it("shows the hint when there is no line", () => {
    render(<StationTransport ed={fakeEditor()} editable calm hint="Drag across the waveform" onMessage={() => {}} />)
    expect(screen.getByTestId("station-status-row").textContent).toContain("Drag across the waveform")
  })

  it("lets Record now's line take the row over the Even out line", () => {
    render(<StationTransport ed={fakeEditor()} editable calm hint="h" onMessage={() => {}} lead={<span data-testid="lead">≈</span>} status={<span data-testid="rec">Recording</span>} />)
    expect(screen.getByTestId("rec")).toBeTruthy()
    expect(screen.getByTestId("lead").closest("[aria-hidden=true]")).not.toBeNull()
  })
})
