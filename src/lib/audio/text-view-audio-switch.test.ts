// AQU-490: whether the audio validation control appears in the TEXT view.
//
// Three states, not two, and the third is the whole point: a project made
// BEFORE this shipped carries a stamped `false` and stays off until a human
// opts in; a project made after carries nothing and turns itself on the moment
// it has audio.
import { describe, it, expect } from "vitest"
import { showAudioValidationInTextView } from "./text-view-audio-switch"

describe("showAudioValidationInTextView", () => {
  // Migration 0096 stamped false onto every project that existed at ship, so a
  // team used to one circle in that gutter does not find a second one there
  // one morning. Sam: older projects opt in.
  it("stays off for a project that opted out, even once it has audio", () => {
    expect(showAudioValidationInTextView({ showAudioValidationInTextView: false }, true)).toBe(false)
  })

  it("stays on for a project that opted in, even before it has audio", () => {
    expect(showAudioValidationInTextView({ showAudioValidationInTextView: true }, false)).toBe(true)
  })

  // THE DERIVED HALF, and why absent cannot be read as false. Nothing writes
  // this key when a project gains its first take — a settings write needs
  // Maintainer and the recorder is usually a contributor — so "off until there
  // is audio, then on" has to be answered live or it never turns on at all.
  it("turns itself on for a new project once it has audio", () => {
    expect(showAudioValidationInTextView({}, false)).toBe(false)
    expect(showAudioValidationInTextView({}, true)).toBe(true)
  })

  it("survives a project that has not loaded yet", () => {
    expect(showAudioValidationInTextView(null, true)).toBe(true)
    expect(showAudioValidationInTextView(undefined, false)).toBe(false)
  })
})
