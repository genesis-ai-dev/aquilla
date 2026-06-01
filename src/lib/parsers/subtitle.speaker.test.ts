import { describe, it, expect } from "vitest"
import { extractVttStrings } from "./subtitle"

describe("extractVttStrings voice tags", () => {
  it("extracts <v Name> into speaker and unwraps the cue text", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Narrator>Hello there</v>\n"
    const [cue] = extractVttStrings(vtt)
    expect(cue.speaker).toBe("Narrator")
    expect(cue.original).toBe("Hello there")
  })

  it("leaves speaker undefined when no voice tag", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPlain line\n"
    const [cue] = extractVttStrings(vtt)
    expect(cue.speaker).toBeUndefined()
    expect(cue.original).toBe("Plain line")
  })
})
