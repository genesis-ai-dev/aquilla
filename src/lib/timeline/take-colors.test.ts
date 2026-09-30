import { describe, expect, it } from "vitest"
import { fileTrackColor, takeTrackColor, takeTrackName, takeTrackVars, tracksForTakesIn } from "./take-colors"

const files = [
  {
    id: "f1",
    trackOverrides: {
      "target-audio": { color: "cyan" },
      "trk-es": { kind: "audio", name: "Spanish", order: 4, color: "magenta" },
    },
  },
  { id: "f2", trackOverrides: null },
]

const hue = (vars: Record<string, string>) => vars["--tl-track-hue"]

describe("takeTrackVars", () => {
  it("draws the main recording and the generated voice in the file's dub-track colour", () => {
    expect(hue(takeTrackVars({ files, fileId: "f1", slot: "recording" }))).toBe("#00c3cd")
    expect(hue(takeTrackVars({ files, fileId: "f1", slot: "generatedVoice" }))).toBe("#00c3cd")
    expect(hue(takeTrackVars({ files, fileId: "f1" }))).toBe("#00c3cd")
  })

  it("draws a take on an added track in that track's own colour", () => {
    expect(hue(takeTrackVars({ files, fileId: "f1", slot: "trk-es" }))).toBe("#da2b84")
  })

  it("uses the media view's default green where nobody has picked a colour", () => {
    expect(hue(takeTrackVars({ files, fileId: "f2", slot: "recording" }))).toBe("#40c06e")
    expect(hue(takeTrackVars({ files: undefined, fileId: "f1" }))).toBe("#40c06e")
  })

  it("never draws a take in grey, even when its track is gone", () => {
    expect(hue(takeTrackVars({ files, fileId: "f1", slot: "trk-deleted" }))).toBe("#40c06e")
  })

  it("draws a source-audio section in the source row's fixed blue", () => {
    const vars = takeTrackVars({ files, fileId: "f1", slot: "recording", sourceSection: true })
    expect(hue(vars)).toBe("#0e9bd6")
  })

  it("carries the take and generated-voice strengths the chip uses", () => {
    const vars = takeTrackVars({ files, fileId: "f1" })
    expect(vars["--tl-track-take"]).toBe("rgba(0, 195, 205, 0.67)")
    expect(vars["--tl-track-gen"]).toBe("rgba(0, 195, 205, 0.33)")
  })
})

describe("fileTrackColor", () => {
  it("reads one track's stored token, null for the default", () => {
    expect(fileTrackColor(files, "f1", "target-audio")).toBe("cyan")
    expect(fileTrackColor(files, "f2", "target-audio")).toBeNull()
    expect(fileTrackColor(files, "nope", "target-audio")).toBeNull()
  })
})

describe("takeTrackColor", () => {
  it("names the colour a take is drawn in, null for the default and for a source section", () => {
    expect(takeTrackColor({ files, fileId: "f1", slot: "generatedVoice" })).toBe("cyan")
    expect(takeTrackColor({ files, fileId: "f1", slot: "trk-es" })).toBe("magenta")
    expect(takeTrackColor({ files, fileId: "f2", slot: "recording" })).toBeNull()
    expect(takeTrackColor({ files, fileId: "f1", sourceSection: true })).toBeNull()
  })
})

// Sam, 2026-09-30: two tracks' takes both read "Take 1"; a take is now named
// by its track too, as the timeline names it.
describe("takeTrackName", () => {
  it("names the track a take sits on, as the timeline does", () => {
    expect(takeTrackName({ files, fileId: "f1", slot: "trk-es" })).toBe("Spanish")
    expect(takeTrackName({ files, fileId: "f1", slot: "recording" })).toBe("Target audio")
    expect(takeTrackName({ files, fileId: "f1", slot: "generatedVoice" })).toBe("Target audio")
  })
  // A heard line's take lives in a cue sibling that is not in the file list;
  // looked up by THAT file, its added track is unknown. Callers pass the
  // timeline's file.
  it("knows no added track of a file it is not given", () => {
    expect(takeTrackName({ files, fileId: "cue-sibling", slot: "trk-es" })).toBeNull()
  })
  it("lists a file's tracks, added ones included", () => {
    expect(tracksForTakesIn(files, "f1").map((t) => t.id)).toContain("trk-es")
  })
})
