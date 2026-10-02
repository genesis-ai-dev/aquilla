import { beforeEach, describe, expect, it, vi } from "vitest"

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock("@/lib/posthog", () => ({ default: { capture } }))

import { reportGeneratedClips, reportQueued, reportValidation } from "./review-telemetry"

beforeEach(() => { capture.mockReset() })

describe("review telemetry (AQU-1572)", () => {
  it("hands the built event to PostHog", () => {
    reportValidation({
      medium: "text", validated: true, projectId: "p1", source: "ui",
      cells: [{ fileId: "f1", cellId: "c1" }],
    })
    expect(capture).toHaveBeenCalledWith("cell validated", expect.objectContaining({ medium: "text", cell_count: 1 }))
  })

  it("never lets a PostHog failure break the action", () => {
    capture.mockImplementation(() => { throw new Error("blocked") })
    expect(() => reportValidation({
      medium: "audio", validated: false, projectId: "p1", source: "ui",
      cells: [{ fileId: "f1", cellId: "c1" }],
    })).not.toThrow()
  })

  it("sends nothing for an action that changed nothing", () => {
    reportValidation({ medium: "text", validated: true, projectId: "p1", source: "ui", cells: [] })
    reportGeneratedClips([], { projectId: "p1" })
    expect(capture).not.toHaveBeenCalled()
  })

  it("reports a run of generated clips as one event", () => {
    reportGeneratedClips([
      { fileId: "f1", cellId: "c1", provider: "inworld", voiceKind: "stock", voiceId: "Dennis", durationMs: 1000 },
      { fileId: "f1", cellId: "c2", provider: "inworld", voiceKind: "stock", voiceId: "Dennis", durationMs: 500 },
    ], { projectId: "p1", surface: "generate-all" })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith("audio generated", expect.objectContaining({
      cell_count: 2, provider: "inworld", voice_kind: "stock", voice_id: "Dennis",
      duration_ms: 1500, surface: "generate-all", source: "ui",
    }))
  })

  it("calls a run with several voices mixed, and names none of them", () => {
    reportGeneratedClips([
      { fileId: "f1", cellId: "c1", provider: "inworld", voiceKind: "stock", voiceId: "Dennis", durationMs: 1000 },
      { fileId: "f1", cellId: "c2", provider: "gemini", voiceKind: "clone" },
    ], { projectId: "p1" })
    const props = capture.mock.calls[0][1]
    expect(props).toMatchObject({ provider: "mixed", voice_kind: "mixed" })
    expect(props).not.toHaveProperty("voice_id")
    // One clip's length is unknown, so the total would be a lie.
    expect(props).not.toHaveProperty("duration_ms")
  })
})

describe("the dev log", () => {
  it("keeps what was sent on window.__aqTelemetry in a dev build", () => {
    const win = window as unknown as { __aqTelemetry?: Array<{ event: string }> }
    win.__aqTelemetry = []
    reportValidation({
      medium: "text", validated: true, projectId: "p1", source: "ui",
      cells: [{ fileId: "f1", cellId: "c1" }],
    })
    const logged: Array<{ event: string }> = win.__aqTelemetry ?? []
    expect(logged.map((e) => e.event)).toEqual(["cell validated"])
  })
})

describe("reportQueued", () => {
  it("reports only the writes that reached the outbox", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const report = vi.fn()
    await reportQueued([Promise.resolve("a"), Promise.reject(new Error("idb")), Promise.resolve("c")], report)
    expect(report).toHaveBeenCalledWith(["a", "c"])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
