import { describe, expect, it } from "vitest"
import {
  clampInworldSpeakingRate,
  formatInworldSpeakingRate,
  inworldDeliveryModeAt,
  inworldSynthFieldsFromVoice,
  INWORLD_SPEAKING_RATE_DEFAULT,
} from "./inworld-voice-settings"
import { normalizeVoiceForProvider } from "./tts-providers"
import type { Voice } from "@/lib/parsers/types"

const inworldVoice: Voice = {
  id: "v1",
  name: "Narrator",
  provider: "inworld",
  voiceName: "Dennis",
  speakingRate: 0.95,
  deliveryMode: "CREATIVE",
  audioQuality: "highest",
}

describe("inworld voice settings", () => {
  it("clamps talking speed to [0.5, 1.5]", () => {
    expect(clampInworldSpeakingRate(0.4)).toBe(0.5)
    expect(clampInworldSpeakingRate(1.7)).toBe(1.5)
    expect(clampInworldSpeakingRate("0.95")).toBe(0.95)
    expect(clampInworldSpeakingRate("nope")).toBeUndefined()
  })

  it("formats the playground speed badge", () => {
    expect(formatInworldSpeakingRate(1)).toBe("1x")
    expect(formatInworldSpeakingRate(0.95)).toBe("0.95x")
    expect(formatInworldSpeakingRate(1.5)).toBe("1.5x")
  })

  it("maps the delivery slider ticks onto Inworld enums", () => {
    expect(inworldDeliveryModeAt(0)).toBe("STABLE")
    expect(inworldDeliveryModeAt(1)).toBe("BALANCED")
    expect(inworldDeliveryModeAt(2)).toBe("CREATIVE")
  })

  it("fills Highest + Stable when playground knobs are unset", () => {
    expect(inworldSynthFieldsFromVoice({ voiceName: "Dennis" } as Voice)).toEqual({
      audioQuality: "highest",
      deliveryMode: "STABLE",
    })
    expect(inworldSynthFieldsFromVoice(inworldVoice)).toEqual({
      speakingRate: 0.95,
      deliveryMode: "CREATIVE",
      audioQuality: "highest",
    })
  })

  it("omits deliveryMode when Standard quality is explicit", () => {
    expect(inworldSynthFieldsFromVoice({ audioQuality: "standard" } as Voice)).toEqual({
      audioQuality: "standard",
    })
  })

  it("strips Inworld knobs when switching away from Inworld", () => {
    const gemini = normalizeVoiceForProvider(inworldVoice, "gemini")
    expect(gemini.speakingRate).toBeUndefined()
    expect(gemini.deliveryMode).toBeUndefined()
    expect(gemini.audioQuality).toBeUndefined()
    expect(gemini.provider).toBe("gemini")
  })

  it("keeps Inworld knobs when staying on Inworld", () => {
    const next = normalizeVoiceForProvider(inworldVoice, "inworld")
    expect(next.speakingRate).toBe(0.95)
    expect(next.deliveryMode).toBe("CREATIVE")
    expect(next.audioQuality).toBe("highest")
  })

  it("treats native speed as 1", () => {
    expect(INWORLD_SPEAKING_RATE_DEFAULT).toBe(1)
  })
})
