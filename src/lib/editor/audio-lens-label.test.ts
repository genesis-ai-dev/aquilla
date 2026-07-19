import { describe, it, expect } from "vitest"
import { Mic2, AudioWaveform } from "lucide-react"
import { audioLensLabel, audioLensIcon } from "./audio-lens-label"

// AQU-353: the header lens toggle and the sidebar "More" nav item both switch
// the same audio/media lens. They must always show the same name + icon, so both
// pull from these helpers. These tests pin the canonical values so the two entry
// points can never silently drift back to "Audio" vs "Voice".
describe("audio lens label/icon (AQU-353 canonical naming)", () => {
  it("labels the cell-file audio lens 'Audio' with the Mic2 icon", () => {
    expect(audioLensLabel(false)).toBe("Audio")
    expect(audioLensIcon(false)).toBe(Mic2)
  })

  it("labels the time-ordered media lens 'Media' with the AudioWaveform icon", () => {
    expect(audioLensLabel(true)).toBe("Media")
    expect(audioLensIcon(true)).toBe(AudioWaveform)
  })

  it("never labels the lens 'Voice' (the old sidebar name that diverged)", () => {
    expect(audioLensLabel(false)).not.toBe("Voice")
    expect(audioLensLabel(true)).not.toBe("Voice")
  })
})
