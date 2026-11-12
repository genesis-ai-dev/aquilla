// A take's shape in the Recording tab's list pulses a placeholder until its
// peaks come back (Sam, 2026-10-01, from the 3G pass: about six seconds of a
// flat body on a slow connection), and stops pulsing whatever the answer.
import { describe, expect, it, vi, beforeEach } from "vitest"
import { act, render, screen } from "@testing-library/react"

const loadMock = vi.fn()
vi.mock("@/lib/audio/peaks-loader", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPeaksFor: (...args: unknown[]) => loadMock(...args),
}))

import { TakeRowWave } from "./TakeRowWave"

const att = { audioId: "take-1", url: "frontier-audio://take-1", durationMs: 3000, trimStartMs: null, trimEndMs: null }

function deferred() {
  let resolve!: (v: Float32Array | null) => void
  const promise = new Promise<Float32Array | null>((res) => { resolve = res })
  return { promise, resolve }
}

function draw(strategy = "lazy") {
  return render(
    <TakeRowWave projectId="p" fileId="f" att={att} session={null} strategy={strategy} generated={false} />,
  )
}

beforeEach(() => loadMock.mockReset())

describe("TakeRowWave — while the shape loads", () => {
  it("pulses until the shape arrives, then draws it", async () => {
    const read = deferred()
    loadMock.mockReturnValueOnce(read.promise)
    draw()
    expect(screen.getByTestId("take-row-wave-take-1-loading")).toBeInTheDocument()
    await act(async () => { read.resolve(new Float32Array([0.3, 1, 0.4])) })
    expect(screen.queryByTestId("take-row-wave-take-1-loading")).toBeNull()
    expect(screen.getByTestId("take-row-wave-take-1-shape")).toBeInTheDocument()
  })

  it("stops pulsing when the read comes back with nothing", async () => {
    const read = deferred()
    loadMock.mockReturnValueOnce(read.promise)
    draw()
    await act(async () => { read.resolve(null) })
    expect(screen.queryByTestId("take-row-wave-take-1-loading")).toBeNull()
  })

  it("does not pulse on a project that loads media only when asked", () => {
    draw("manual")
    expect(loadMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId("take-row-wave-take-1-loading")).toBeNull()
  })
})
