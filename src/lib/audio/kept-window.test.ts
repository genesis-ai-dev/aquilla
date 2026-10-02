import { describe, expect, it } from "vitest"
import { isSourceClipFor, keptWindowSec } from "./kept-window"

// Ids follow buildAudioId's seeding: a take carries its CELL id, the imported
// source clip carries its FILE id.
const take = "rec-c1-abc.wav"
const source = "src-f1-xyz.wav"
const cell = { id: "c1", medium: "media", selectedAudioId: source, startTime: 17.6, endTime: 23.1 }

describe("keptWindowSec", () => {
  it("reads a take's stored trim in seconds", () => {
    expect(keptWindowSec({ id: "c1" }, take, { trimStartMs: 300, trimEndMs: 2700 }))
      .toEqual({ start: 0.3, end: 2.7, kind: "trim" })
  })

  it("leaves an untrimmed side open", () => {
    expect(keptWindowSec({ id: "c1" }, take, { trimStartMs: 300 })).toEqual({ start: 0.3, end: null, kind: "trim" })
    expect(keptWindowSec({ id: "c1" }, take, { trimEndMs: 2700 })).toEqual({ start: null, end: 2.7, kind: "trim" })
  })

  it("is no window at all for an untrimmed take", () => {
    expect(keptWindowSec({ id: "c1" }, take, {})).toEqual({ start: null, end: null, kind: "none" })
    expect(keptWindowSec({ id: "c1" }, take, { trimStartMs: 0 }).kind).toBe("none")
  })

  it("ignores an end that does not come after the start", () => {
    expect(keptWindowSec({ id: "c1" }, take, { trimStartMs: 900, trimEndMs: 900 }))
      .toEqual({ start: 0.9, end: null, kind: "trim" })
  })

  it("gives a source-audio section its own timing, never the transcription trim", () => {
    expect(keptWindowSec(cell, source, { trimStartMs: 17_900, trimEndMs: 22_800 }))
      .toEqual({ start: 17.6, end: 23.1, kind: "section" })
  })

  it("treats a take on a media section as a take", () => {
    expect(keptWindowSec(cell, take, { trimStartMs: 200 })).toEqual({ start: 0.2, end: null, kind: "trim" })
  })

  it("has no window for a source clip without usable timing", () => {
    expect(keptWindowSec({ ...cell, endTime: undefined }, source, undefined).kind).toBe("none")
  })
})

describe("isSourceClipFor", () => {
  it("is only the file-seeded clip in the selected slot of a media cell", () => {
    expect(isSourceClipFor(cell, source)).toBe(true)
    expect(isSourceClipFor(cell, take)).toBe(false)
    expect(isSourceClipFor({ ...cell, medium: "text" }, source)).toBe(false)
    expect(isSourceClipFor({ ...cell, selectedAudioId: take }, source)).toBe(false)
  })
})
