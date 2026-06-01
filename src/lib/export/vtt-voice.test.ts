import { describe, it, expect } from "vitest"
import { escapeVoiceName, extractVoiceLabel } from "./vtt-voice"

describe("escapeVoiceName", () => {
  it("strips <,> and collapses newlines", () => {
    expect(escapeVoiceName("Ma<ry>\nJane")).toBe("Mary Jane")
  })
})

describe("extractVoiceLabel", () => {
  it("pulls a <v Speaker>...</v> span into speaker + unwrapped text", () => {
    expect(extractVoiceLabel("<v Narrator>Hello there</v>")).toEqual({ speaker: "Narrator", text: "Hello there" })
  })
  it("supports open-ended <v Speaker>... without closing tag", () => {
    expect(extractVoiceLabel("<v Mary>Hi")).toEqual({ speaker: "Mary", text: "Hi" })
  })
  it("returns null speaker and original text when no voice tag", () => {
    expect(extractVoiceLabel("Just text")).toEqual({ speaker: null, text: "Just text" })
  })
})
