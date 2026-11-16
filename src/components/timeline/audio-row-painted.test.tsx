import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AudioRowPaintedContext, useNotifyAudioRowPainted } from "./audio-row-painted"

function Probe() {
  useNotifyAudioRowPainted()
  return <div data-testid="tl-target-lane" />
}

describe("useNotifyAudioRowPainted", () => {
  it("tells the workspace the target row has committed", () => {
    const mark = vi.fn()
    render(
      <AudioRowPaintedContext.Provider value={mark}>
        <Probe />
      </AudioRowPaintedContext.Provider>,
    )
    expect(mark).toHaveBeenCalledOnce()
  })
})
