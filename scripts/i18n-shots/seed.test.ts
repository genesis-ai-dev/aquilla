import { describe, expect, it } from "vitest"
import { audioIdSeededWith } from "@/lib/audio/upload"
import {
  SEEDED_AUDIO_DURATION_MS,
  SEEDED_AUDIO_LINE_COUNT,
  seededAudioId,
  toneWavBytes,
} from "./seed"

describe("i18n-shots audio seed helpers", () => {
  it("embeds the cell id so playback treats the take as a per-cell recording", () => {
    const cellId = "GEN 1:1"
    const audioId = seededAudioId(cellId)
    expect(audioIdSeededWith(audioId, cellId)).toBe(true)
    expect(audioIdSeededWith(audioId, "019f9000-0000-7000-8000-000000000001")).toBe(false)
  })

  it("writes a valid PCM WAV whose payload matches the seeded duration", () => {
    const sampleRate = 16_000
    const bytes = toneWavBytes(440, SEEDED_AUDIO_DURATION_MS, sampleRate)
    const header = new TextDecoder().decode(bytes.slice(0, 12))
    expect(header.slice(0, 4)).toBe("RIFF")
    expect(header.slice(8, 12)).toBe("WAVE")
    const sampleCount = Math.round((sampleRate * SEEDED_AUDIO_DURATION_MS) / 1000)
    expect(bytes.byteLength).toBe(44 + sampleCount * 2)
  })

  it("voices a prefix of the sample file so some rows stay unvoiced", () => {
    expect(SEEDED_AUDIO_LINE_COUNT).toBe(3)
  })
})
