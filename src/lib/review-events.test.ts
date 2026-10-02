import { describe, expect, it } from "vitest"
import {
  audioAttachedEvent,
  audioGeneratedEvent,
  audioRecordedEvent,
  telemetryCellId,
  validationEvent,
} from "./review-events"

const UUID = "01a0f305-61ea-7cfd-8a03-dab4dfb4010a"
const UUID2 = "01a0f305-61ea-7cfd-8a03-dab4dfb4010b"

describe("validationEvent (AQU-1572)", () => {
  it("names the event by direction and carries the medium", () => {
    const on = validationEvent({
      medium: "text", validated: true, projectId: "p1",
      cells: [{ fileId: "f1", cellId: UUID }], lane: "", source: "ui", surface: "cell",
    })
    expect(on).toEqual({
      event: "cell validated",
      properties: {
        project_id: "p1", file_id: "f1", cell_id: UUID, lane: "default",
        source: "ui", surface: "cell", cell_count: 1, medium: "text",
      },
    })
    const off = validationEvent({
      medium: "audio", validated: false, projectId: "p1",
      cells: [{ fileId: "f1", cellId: UUID }], lane: "es", source: "agent",
    })
    expect(off?.event).toBe("cell unvalidated")
    expect(off?.properties).toMatchObject({ medium: "audio", lane: "es", source: "agent" })
  })

  it("is one event for a bulk action, naming no single cell", () => {
    const e = validationEvent({
      medium: "text", validated: true, projectId: "p1", source: "ui", surface: "selection",
      cells: [{ fileId: "f1", cellId: UUID }, { fileId: "f1", cellId: UUID2 }],
    })
    expect(e?.properties.cell_count).toBe(2)
    expect(e?.properties.file_id).toBe("f1")
    expect(e?.properties).not.toHaveProperty("cell_id")
  })

  it("counts a line once however many of its takes were voted on", () => {
    const e = validationEvent({
      medium: "audio", validated: true, projectId: "p1", source: "ui",
      cells: [{ fileId: "f1", cellId: UUID }, { fileId: "f1", cellId: UUID }],
    })
    expect(e?.properties.cell_count).toBe(1)
    expect(e?.properties.cell_id).toBe(UUID)
  })

  it("names neither file nor cell when the action spans files", () => {
    const e = validationEvent({
      medium: "audio", validated: true, projectId: "p1", source: "ui",
      cells: [{ fileId: "f1", cellId: UUID }, { fileId: "f2", cellId: UUID2 }],
    })
    expect(e?.properties).not.toHaveProperty("file_id")
    expect(e?.properties.file_count).toBe(2)
  })

  it("sends nothing when no cell changed", () => {
    expect(validationEvent({
      medium: "text", validated: true, projectId: "p1", cells: [], source: "ui",
    })).toBeNull()
  })
})

describe("telemetryCellId", () => {
  it("passes an opaque id and drops a verse reference", () => {
    expect(telemetryCellId(UUID)).toBe(UUID)
    // A Bible cell id names the passage — exactly what replay masking hides.
    expect(telemetryCellId("GEN 1:1")).toBeUndefined()
    expect(telemetryCellId("")).toBeUndefined()
  })
})

describe("audio events", () => {
  const target = { projectId: "p1", cells: [{ fileId: "f1", cellId: UUID }], source: "ui" as const }

  it("attached: method and a rounded duration", () => {
    expect(audioAttachedEvent({ ...target, method: "upload", durationMs: 2250.4 })).toEqual({
      event: "audio attached",
      properties: expect.objectContaining({ method: "upload", duration_ms: 2250, cell_count: 1 }),
    })
    // An unknown length is left out rather than sent as 0.
    expect(audioAttachedEvent({ ...target, method: "link", durationMs: undefined })?.properties)
      .not.toHaveProperty("duration_ms")
  })

  it("recorded: whether the take validated itself", () => {
    expect(audioRecordedEvent({ ...target, autoValidated: true, durationMs: 1200 })?.properties)
      .toMatchObject({ auto_validated: true, duration_ms: 1200 })
  })

  it("generated: a stock voice is named, a clone only by its kind", () => {
    expect(audioGeneratedEvent({ ...target, provider: "inworld", voiceKind: "stock", voiceId: "Dennis" })?.properties)
      .toMatchObject({ provider: "inworld", voice_kind: "stock", voice_id: "Dennis" })
    const clone = audioGeneratedEvent({ ...target, provider: "inworld", voiceKind: "clone", voiceId: "workspace__joel_1" })
    expect(clone?.properties.voice_kind).toBe("clone")
    expect(clone?.properties).not.toHaveProperty("voice_id")
  })
})
