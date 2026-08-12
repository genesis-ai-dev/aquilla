import { describe, it, expect } from "vitest"
import { Mic2, AudioWaveform } from "lucide-react"
import { audioLensLabelKey, audioLensIcon } from "./audio-lens-label"
import { en } from "@/lib/i18n/messages/en"

// AQU-353: the header lens toggle and the sidebar "More" nav item both switch
// the same audio/media lens. They must always show the same name + icon, so both
// pull from these helpers. These tests pin the canonical values so the two entry
// points can never silently drift back to "Audio" vs "Voice".
//
// The lens label is now a catalog key rather than a resolved English string
// (AQU-511 trunk fan-out) — resolve it through the base `en` catalog to assert
// on the actual visible text a locale-less caller would render.
describe("audio lens label/icon (AQU-353 canonical naming)", () => {
  it("labels the cell-file audio lens 'Audio' with the Mic2 icon", () => {
    expect(en[audioLensLabelKey(false)]).toBe("Audio")
    expect(audioLensIcon(false)).toBe(Mic2)
  })

  it("labels the time-ordered media lens 'Media' with the AudioWaveform icon", () => {
    expect(en[audioLensLabelKey(true)]).toBe("Media")
    expect(audioLensIcon(true)).toBe(AudioWaveform)
  })

  it("never labels the lens 'Voice' (the old sidebar name that diverged)", () => {
    expect(en[audioLensLabelKey(false)]).not.toBe("Voice")
    expect(en[audioLensLabelKey(true)]).not.toBe("Voice")
  })

  it("uses distinct keys for the two lenses", () => {
    expect(audioLensLabelKey(false)).not.toBe(audioLensLabelKey(true))
  })
})
