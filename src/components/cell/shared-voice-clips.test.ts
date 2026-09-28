import { describe, expect, it } from "vitest"
import { sharedGeneratedClipIds } from "./shared-voice-clips"

describe("sharedGeneratedClipIds", () => {
  it("finds a generated clip selected by more than one line (voiced together)", () => {
    const shared = sharedGeneratedClipIds([
      { selectedGeneratedVoiceAudioId: "combined.wav" },
      { selectedGeneratedVoiceAudioId: "combined.wav" },
      { selectedGeneratedVoiceAudioId: "own.wav" },
      { selectedGeneratedVoiceAudioId: null },
      {},
    ])
    expect([...shared]).toEqual(["combined.wav"])
  })
})
