/**
 * AQU-1572: the two things `cell-telemetry.ts` adds around `posthog.capture`:
 * the dev-build log Sam checks events with by hand, and the guarantee that a
 * failing capture never fails the gesture it describes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock("@/lib/posthog", () => ({ default: { capture } }))

import { captureAudioAction, captureCellValidation } from "./cell-telemetry"

type Logged = { event: string; properties: Record<string, unknown> }
const devLog = () => (window as unknown as { __aqTelemetry?: Logged[] }).__aqTelemetry

beforeEach(() => {
  capture.mockReset()
  ;(window as unknown as { __aqTelemetry?: Logged[] }).__aqTelemetry = []
})

describe("the dev log (window.__aqTelemetry)", () => {
  it("keeps exactly what was handed to PostHog, in a dev build", () => {
    captureCellValidation(true, { medium: "text", projectId: "p1", fileId: "f1", cellId: "c1" })
    captureAudioAction({ origin: "record", projectId: "p1", fileId: "f1", cellId: "c1", slot: "recording" })
    expect(devLog()?.map((e) => e.event)).toEqual(["cell validated", "audio recorded"])
    expect(devLog()?.[0].properties).toEqual(capture.mock.calls[0][1])
  })

  it("keeps only the most recent 200", () => {
    for (let i = 0; i < 205; i++) {
      captureCellValidation(true, { medium: "text", projectId: "p1", fileId: "f1", cellId: `c${i}` })
    }
    expect(devLog()).toHaveLength(200)
    expect(devLog()?.[0].properties.cell_id).toBe("c5")
  })
})

describe("a capture that throws", () => {
  it("is swallowed, so the emit that already queued its write still resolves", () => {
    capture.mockImplementation(() => { throw new Error("posthog down") })
    expect(() =>
      captureCellValidation(false, { medium: "audio", projectId: "p1", fileId: "f1", cellId: "c1" }),
    ).not.toThrow()
    expect(() =>
      captureAudioAction({ origin: "attach", projectId: "p1", fileId: "f1", cellId: "c1", slot: "recording" }),
    ).not.toThrow()
  })
})
