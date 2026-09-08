import { describe, expect, it } from "vitest"
import { DEFAULT_INWORLD_VOICE } from "./tts-providers"
import {
  migrateOmnivoiceTtsSettings,
  migrateOmnivoiceVoice,
  ttsSettingsNeedOmnivoiceMigration,
} from "./omnivoice-migrate"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

const omnivoiceVoice = (overrides: Partial<Voice> = {}): Voice => ({
  id: "v1",
  name: "Narrator",
  provider: "omnivoice",
  ...overrides,
})

describe("ttsSettingsNeedOmnivoiceMigration", () => {
  it("is true for a project-level omnivoice id or a leftover voice", () => {
    expect(ttsSettingsNeedOmnivoiceMigration({ provider: "omnivoice" })).toBe(true)
    expect(ttsSettingsNeedOmnivoiceMigration({
      provider: "gemini",
      voices: [omnivoiceVoice()],
    })).toBe(true)
  })

  it("is false once everything is already inworld", () => {
    expect(ttsSettingsNeedOmnivoiceMigration(undefined)).toBe(false)
    expect(ttsSettingsNeedOmnivoiceMigration({ provider: "inworld" })).toBe(false)
    expect(ttsSettingsNeedOmnivoiceMigration({
      provider: "inworld",
      voices: [{ id: "v", name: "N", provider: "inworld", voiceName: "Dennis", language: "en-US" }],
    })).toBe(false)
  })
})

describe("migrateOmnivoiceVoice", () => {
  it("rewrites provider, stock voice, and ISO-639-3 language onto Inworld", () => {
    const next = migrateOmnivoiceVoice(omnivoiceVoice({ language: "eng" }))
    expect(next.provider).toBe("inworld")
    expect(next.voiceName).toBe(DEFAULT_INWORLD_VOICE)
    expect(next.language).toBe("en-US")
    expect(next.audioQuality).toBe("highest")
    expect(next.deliveryMode).toBe("STABLE")
  })

  it("maps a display-name language and a bare primary tag", () => {
    expect(migrateOmnivoiceVoice(omnivoiceVoice({ language: "French" })).language).toBe("fr-FR")
    expect(migrateOmnivoiceVoice(omnivoiceVoice({ language: "en" })).language).toBe("en-US")
    expect(migrateOmnivoiceVoice(omnivoiceVoice({ language: "en-GB" })).language).toBe("en-GB")
  })

  it("keeps an unmapped label and fills from the project lane when the voice has none", () => {
    expect(migrateOmnivoiceVoice(omnivoiceVoice({ language: "Grade 7 English" })).language)
      .toBe("Grade 7 English")
    expect(migrateOmnivoiceVoice(omnivoiceVoice(), { targetLanguage: "spa" }).language).toBe("es-ES")
  })

  it("keeps an Instant Clone id and reference clip", () => {
    const cloned = migrateOmnivoiceVoice(omnivoiceVoice({
      voiceName: "ws__narrator_old",
      referenceAudioId: "ref1.wav",
      language: "fra",
    }))
    expect(cloned.voiceName).toBe("ws__narrator_old")
    expect(cloned.referenceAudioId).toBe("ref1.wav")
    expect(cloned.language).toBe("fr-FR")
  })

  it("returns the same object when the voice is already Gemini", () => {
    const gemini: Voice = { id: "g", name: "G", provider: "gemini", voiceName: "Kore" }
    expect(migrateOmnivoiceVoice(gemini, { projectProvider: "omnivoice" })).toBe(gemini)
  })
})

describe("migrateOmnivoiceTtsSettings", () => {
  it("returns the same object when nothing is OmniVoice", () => {
    const settings: ProjectTtsSettings = {
      provider: "inworld",
      voices: [{ id: "v", name: "N", provider: "inworld", voiceName: "Dennis", language: "en-US" }],
    }
    expect(migrateOmnivoiceTtsSettings(settings)).toBe(settings)
    expect(migrateOmnivoiceTtsSettings(undefined)).toBeUndefined()
  })

  it("rewrites the project default and inherited voices in one pass", () => {
    const settings: ProjectTtsSettings = {
      provider: "omnivoice",
      defaultVoiceId: "v1",
      voices: [
        { id: "v1", name: "Narrator", language: "eng" },
        { id: "v2", name: "Mary", provider: "gemini", voiceName: "Kore" },
        omnivoiceVoice({ id: "v3", name: "Clone", language: "French", referenceAudioId: "r.wav" }),
      ],
    }
    const next = migrateOmnivoiceTtsSettings(settings, { targetLanguage: "fra" })
    expect(next).not.toBe(settings)
    expect(next?.provider).toBe("inworld")
    expect(next?.defaultVoiceId).toBe("v1")
    expect(next?.voices?.[0]).toMatchObject({
      id: "v1", provider: "inworld", voiceName: DEFAULT_INWORLD_VOICE, language: "en-US",
    })
    expect(next?.voices?.[1]).toEqual(settings.voices?.[1])
    expect(next?.voices?.[2]).toMatchObject({
      id: "v3", provider: "inworld", language: "fr-FR", referenceAudioId: "r.wav",
    })
  })
})
