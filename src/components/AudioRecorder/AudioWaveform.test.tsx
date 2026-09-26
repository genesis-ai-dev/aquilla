// The take being recorded, growing (AQU-1210). happy-dom has no audio graph
// or canvas, so both are faked; what is pinned is what the operator sees move:
// the recorded part of the body and the red line at its edge.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, act } from "@testing-library/react"
import { AudioWaveform } from "./AudioWaveform"

let frames: Array<FrameRequestCallback> = []
let now = 0
const level = { value: 0.2 }

class FakeAnalyser {
  fftSize = 1024
  smoothingTimeConstant = 0
  connect() {}
  disconnect() {}
  getFloatTimeDomainData(buf: Float32Array) {
    buf.fill(0)
    buf[0] = level.value
  }
}
class FakeAudioContext {
  static made = 0
  constructor() { FakeAudioContext.made++ }
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createAnalyser() { return new FakeAnalyser() }
  close() { return Promise.resolve() }
}

const ctx2d = {
  setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
  lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), globalAlpha: 1, fillStyle: "",
}

function step(ms: number) {
  now += ms
  const due = frames
  frames = []
  act(() => { for (const f of due) f(now) })
}

beforeEach(() => {
  frames = []
  now = 1000
  level.value = 0.2
  FakeAudioContext.made = 0
  vi.stubGlobal("AudioContext", FakeAudioContext)
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { frames.push(f); return frames.length })
  vi.stubGlobal("cancelAnimationFrame", () => { frames = [] })
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx2d as never)
  Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", { configurable: true, get: () => 400 })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const stream = {} as MediaStream
const grown = () => screen.getByTestId("rec-live-waveform").style.getPropertyValue("--tl-play-x")
const cursor = () => screen.getByTestId("rec-live-cursor")

describe("AudioWaveform — the take, growing", () => {
  it("is an empty body while counting in: nothing recorded, no red line", () => {
    render(<AudioWaveform stream={stream} tone="armed" targetSec={2.5} />)
    step(16); step(500)
    expect(grown()).toBe("0%")
    expect(cursor().style.display).toBe("none")
  })

  it("grows from the left on the target bar's own axis, the red line at its edge", () => {
    render(<AudioWaveform stream={stream} tone="live" targetSec={2.5} />)
    step(16) // the take begins on the first live frame
    step(1000)
    // 1s into a 2.5s target + 1.5s headroom = a quarter of the way.
    expect(grown()).toBe("25%")
    expect(cursor().style.display).toBe("block")
    expect(cursor().style.left).toBe("25%")
  })

  it("holds the whole take once it runs past the span", () => {
    render(<AudioWaveform stream={stream} tone="live" targetSec={1} />)
    step(16)
    step(4000)
    expect(grown()).toBe("100%")
  })

  it("recolouring from counting to recording keeps the ONE audio graph, and starts the take at zero", () => {
    const { rerender } = render(<AudioWaveform stream={stream} tone="armed" targetSec={2.5} />)
    step(16); step(2000) // a long countdown must not count into the take
    rerender(<AudioWaveform stream={stream} tone="live" targetSec={2.5} />)
    step(16)
    step(500)
    expect(grown()).toBe("12.5%")
    expect(FakeAudioContext.made).toBe(1)
  })

  it("the next take starts from nothing, not where the last one ended", () => {
    const { rerender } = render(<AudioWaveform stream={stream} tone="live" targetSec={2.5} />)
    step(16); step(3000)
    rerender(<AudioWaveform stream={stream} tone="armed" targetSec={2.5} />)
    step(16)
    expect(grown()).toBe("0%")
    rerender(<AudioWaveform stream={stream} tone="live" targetSec={2.5} />)
    step(16); step(1000)
    expect(grown()).toBe("25%")
  })

  it("with no microphone stream it draws nothing", () => {
    render(<AudioWaveform stream={null} tone="live" />)
    expect(grown()).toBe("0%")
    expect(cursor().style.display).toBe("none")
    expect(FakeAudioContext.made).toBe(0)
  })
})
