// Pausing playback when the output device changes. (AQU-646)
//
// The whole risk in this feature is FALSE POSITIVES. `devicechange` fires for
// microphones and webcams too, and stopping someone's review session because
// they plugged in a USB mic would be a worse bug than the drift this fixes. So
// most of what is pinned here is the watcher declining to act.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"

const pauseAllTransports = vi.fn()
vi.mock("./transport-pause", () => ({ pauseAllTransports: () => pauseAllTransports() }))

// The real module is a STORE: the getter returns the last PUBLISHED value and
// only `refreshOutputLatency()` re-reads the device. Modelling that faithfully
// is the whole point — a mock whose getter reads the device live would make
// "what it was before" and "what it is now" the same number, and the watcher
// could never see a change.
let deviceLatency = 0
let published = 0
let readable = true
vi.mock("./output-latency", () => ({
  getOutputLatencySec: () => published,
  refreshOutputLatency: () => {
    if (!readable) return false
    published = deviceLatency
    return true
  },
}))

import { startOutputDeviceWatch } from "./output-device-watch"
import { setMicHeld, __resetMicHoldForTests } from "./mic-hold"

class FakeMediaDevices extends EventTarget {}
let devices: FakeMediaDevices

function watch(isPlaying = true) {
  const onPaused = vi.fn()
  const stop = startOutputDeviceWatch({ isPlaying: () => isPlaying, onPaused })
  return { onPaused, stop }
}

/** One physical switch: the event, then the device settling to a new latency. */
async function switchDevice(to: number) {
  devices.dispatchEvent(new Event("devicechange"))
  deviceLatency = to
  await vi.advanceTimersByTimeAsync(3000)
}

beforeEach(() => {
  vi.useFakeTimers()
  pauseAllTransports.mockClear()
  deviceLatency = 0.02
  published = 0.02
  readable = true
  __resetMicHoldForTests()
  devices = new FakeMediaDevices()
  vi.stubGlobal("navigator", { mediaDevices: devices })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetMicHoldForTests()
})

describe("when the output really changed", () => {
  it("pauses everything and says so, once", async () => {
    const { onPaused, stop } = watch()
    await switchDevice(0.178) // wired → Bluetooth
    expect(pauseAllTransports).toHaveBeenCalledTimes(1)
    expect(onPaused).toHaveBeenCalledTimes(1)
    stop()
  })

  it("coalesces the burst of events one physical switch produces", async () => {
    const { stop } = watch()
    devices.dispatchEvent(new Event("devicechange"))
    devices.dispatchEvent(new Event("devicechange"))
    devices.dispatchEvent(new Event("devicechange"))
    deviceLatency = 0.178
    await vi.advanceTimersByTimeAsync(3000)
    expect(pauseAllTransports).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe("when it should keep quiet", () => {
  it("does nothing when the latency did not move — a mic or a webcam", async () => {
    const { onPaused, stop } = watch()
    await switchDevice(0.02) // unchanged
    expect(pauseAllTransports).not.toHaveBeenCalled()
    expect(onPaused).not.toHaveBeenCalled()
    stop()
  })

  it("does nothing when the reading is unavailable — it will not guess", async () => {
    readable = false
    const { stop } = watch()
    await switchDevice(0.178)
    expect(pauseAllTransports).not.toHaveBeenCalled()
    stop()
  })

  it("does not pause something that is not playing", async () => {
    const { onPaused, stop } = watch(false)
    await switchDevice(0.178)
    expect(pauseAllTransports).not.toHaveBeenCalled()
    expect(onPaused).not.toHaveBeenCalled()
    stop()
  })

  it("stands down entirely while the recorder holds the mic", async () => {
    setMicHeld(true)
    const { stop } = watch()
    await switchDevice(0.178)
    expect(pauseAllTransports).not.toHaveBeenCalled()
    stop()
  })

  it("ignores a change that lands after it was stopped", async () => {
    const { stop } = watch()
    devices.dispatchEvent(new Event("devicechange"))
    stop()
    deviceLatency = 0.178
    await vi.advanceTimersByTimeAsync(3000)
    expect(pauseAllTransports).not.toHaveBeenCalled()
  })
})

describe("when the platform has no device API", () => {
  it("starts and stops without throwing", () => {
    // happy-dom has no navigator.mediaDevices — and neither does any browser on
    // an insecure origin.
    vi.stubGlobal("navigator", {})
    const stop = startOutputDeviceWatch({ isPlaying: () => true, onPaused: () => {} })
    expect(() => stop()).not.toThrow()
  })
})
