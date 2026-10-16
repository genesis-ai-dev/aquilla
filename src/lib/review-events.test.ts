/**
 * AQU-1572: the shared event builders. The browser (cell-telemetry.ts) and
 * the sync-worker (external/review-telemetry.ts) both send what these build,
 * so these tests are the one statement of the event shape; the worker's own
 * test checks it sends exactly these property names too.
 */
import { describe, expect, it } from "vitest"
import {
  AUDIO_EVENT_PROPERTIES,
  VALIDATION_EVENT_PROPERTIES,
  audioActionEvent,
  cellValidationEvent,
  telemetryCellId,
} from "./review-events"

const UUID = "01a0f305-61ea-7cfd-8a03-dab4dfb4010a"

describe("cellValidationEvent", () => {
  it("is one line's `cell validated`, with every property the dashboards read", () => {
    expect(cellValidationEvent(true, {
      medium: "text", projectId: "p1", fileId: "f1", cellId: UUID,
      lane: "es", source: "ui", auto: false, surface: "selection",
    })).toEqual({
      event: "cell validated",
      properties: {
        medium: "text", project_id: "p1", file_id: "f1", cell_id: UUID,
        lane: "es", source: "ui", auto: false, surface: "selection",
      },
    })
  })

  it("names the direction and the medium", () => {
    const off = cellValidationEvent(false, { medium: "audio", projectId: "p1", fileId: "f1", cellId: UUID })
    expect(off.event).toBe("cell unvalidated")
    expect(off.properties.medium).toBe("audio")
  })

  it("defaults: the default lane is '', a person in the UI, not automatic, no surface", () => {
    const { properties } = cellValidationEvent(true, { medium: "text", projectId: "p1", fileId: "f1", cellId: UUID })
    expect(properties).toMatchObject({ lane: "", source: "ui", auto: false })
    expect(properties).not.toHaveProperty("surface")
  })

  it("never names a verse-reference cell, only its file", () => {
    const { properties } = cellValidationEvent(true, { medium: "text", projectId: "p1", fileId: "f1", cellId: "MAT 1:1" })
    expect(properties).not.toHaveProperty("cell_id")
    expect(properties.file_id).toBe("f1")
    expect(JSON.stringify(properties)).not.toContain("MAT")
  })

  it("never sends a property outside the shared list", () => {
    const { properties } = cellValidationEvent(true, {
      medium: "text", projectId: "p1", fileId: "f1", cellId: UUID,
      lane: "es", source: "api", auto: false, surface: "api",
    })
    expect(Object.keys(properties).sort()).toEqual([...VALIDATION_EVENT_PROPERTIES].sort())
  })
})

describe("audioActionEvent", () => {
  it("names the event by where the clip came from", () => {
    const base = { projectId: "p1", fileId: "f1", cellId: UUID, slot: "recording" }
    expect(audioActionEvent({ ...base, origin: "attach" }).event).toBe("audio attached")
    expect(audioActionEvent({ ...base, origin: "generate" }).event).toBe("audio generated")
    expect(audioActionEvent({ ...base, origin: "record" }).event).toBe("audio recorded")
  })

  it("carries the voice, provider and a whole-millisecond duration for a generation", () => {
    expect(audioActionEvent({
      origin: "generate", projectId: "p1", fileId: "f1", cellId: UUID, slot: "generatedVoice",
      lane: "es", source: "ui", surface: "voice-panel", voiceId: "voice-7", provider: "inworld", durationMs: 1234.6,
    }).properties).toEqual({
      project_id: "p1", file_id: "f1", cell_id: UUID, slot: "generatedVoice", lane: "es", source: "ui",
      surface: "voice-panel", voice_id: "voice-7", provider: "inworld", duration_ms: 1235,
    })
  })

  it("leaves out what it does not know, and a verse-reference cell", () => {
    const { properties } = audioActionEvent({ origin: "attach", projectId: "p1", fileId: "f1", cellId: "GEN 1:1", slot: "recording" })
    expect(properties).toEqual({ project_id: "p1", file_id: "f1", slot: "recording", lane: "", source: "ui" })
  })

  it("never sends a property outside the shared list", () => {
    const { properties } = audioActionEvent({
      origin: "generate", projectId: "p1", fileId: "f1", cellId: UUID, slot: "s", lane: "", source: "ui",
      surface: "cell", voiceId: "v", provider: "inworld", durationMs: 1,
    })
    expect(Object.keys(properties).sort()).toEqual([...AUDIO_EVENT_PROPERTIES].sort())
  })
})

describe("telemetryCellId", () => {
  it("passes a UUID and nothing else", () => {
    expect(telemetryCellId(UUID)).toBe(UUID)
    expect(telemetryCellId("MRK 4:1")).toBeUndefined()
    expect(telemetryCellId("cell-1")).toBeUndefined()
    expect(telemetryCellId("")).toBeUndefined()
    expect(telemetryCellId(null)).toBeUndefined()
  })
})
