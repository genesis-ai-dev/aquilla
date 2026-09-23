import { describe, expect, it } from "vitest"
import {
  catalogLanguagesForInworld,
  formatInworldLanguageLabel,
  formatVoiceLanguageName,
  inworldLanguageForRequest,
  isListedInworldLanguage,
  languageForVoiceDescription,
  needsInworldLanguagePicker,
  toInworldLanguage,
  toInworldLanguageLoose,
} from "./inworld-languages"

describe("toInworldLanguage", () => {
  it("maps ISO-639-3 scripture codes onto BCP-47", () => {
    expect(toInworldLanguage("eng")).toBe("en-US")
    expect(toInworldLanguage("spa")).toBe("es-ES")
    expect(toInworldLanguage("fra")).toBe("fr-FR")
  })

  it("keeps BCP-47, 2-letter, and ISO-639-3 language subtags", () => {
    expect(toInworldLanguage("en-GB")).toBe("en-GB")
    expect(toInworldLanguage("pt-BR")).toBe("pt-BR")
    expect(toInworldLanguage("en")).toBe("en")
    expect(toInworldLanguage("fil")).toBe("fil")
    expect(toInworldLanguage("yue")).toBe("yue")
    expect(toInworldLanguage("ceb")).toBe("ceb")
    expect(toInworldLanguage("en-scottish")).toBe("en-scottish")
    expect(toInworldLanguage("en-GB-u-sd-gbwls")).toBe("en-GB-u-sd-gbwls")
  })

  it("rejects display names and empty tags", () => {
    expect(toInworldLanguage("French")).toBeUndefined()
    expect(toInworldLanguage("Grade 7 English")).toBeUndefined()
    expect(toInworldLanguage("auto")).toBeUndefined()
    expect(toInworldLanguage("")).toBeUndefined()
    expect(toInworldLanguage(undefined)).toBeUndefined()
  })
})

describe("toInworldLanguageLoose", () => {
  it("canonicalizes ISO-639-3 and bare primary tags onto listed Inworld codes", () => {
    expect(toInworldLanguageLoose("eng")).toBe("en-US")
    expect(toInworldLanguageLoose("en")).toBe("en-US")
    expect(toInworldLanguageLoose("spa")).toBe("es-ES")
    expect(toInworldLanguageLoose("fra")).toBe("fr-FR")
    expect(toInworldLanguageLoose("fr")).toBe("fr-FR")
  })

  it("keeps an already-regional Inworld tag", () => {
    expect(toInworldLanguageLoose("en-GB")).toBe("en-GB")
    expect(toInworldLanguageLoose("pt-BR")).toBe("pt-BR")
  })

  it("maps catalog display names", () => {
    expect(toInworldLanguageLoose("French")).toBe("fr-FR")
    expect(toInworldLanguageLoose("spanish")).toBe("es-ES")
  })

  it("leaves unmapped labels alone", () => {
    expect(toInworldLanguageLoose("Grade 7 English")).toBeUndefined()
    expect(toInworldLanguageLoose("Tok Pisin")).toBeUndefined()
    expect(toInworldLanguageLoose("auto")).toBeUndefined()
    expect(toInworldLanguageLoose("")).toBeUndefined()
    expect(toInworldLanguageLoose(undefined)).toBeUndefined()
  })
})

describe("needsInworldLanguagePicker", () => {
  it("is true when any lane does not map onto an Inworld language", () => {
    expect(needsInworldLanguagePicker(["French"])).toBe(true)
    expect(needsInworldLanguagePicker(["Grade 7 English", "Tok Pisin"])).toBe(true)
    expect(needsInworldLanguagePicker(["French", "es"])).toBe(true)
  })

  it("is false when there is no lane, or every lane is a code Inworld understands", () => {
    expect(needsInworldLanguagePicker([])).toBe(false)
    expect(needsInworldLanguagePicker(["en"])).toBe(false)
    expect(needsInworldLanguagePicker(["en", "es"])).toBe(false)
    expect(needsInworldLanguagePicker(["fra"])).toBe(false)
  })
})

describe("catalogLanguagesForInworld", () => {
  it("unions mapped lanes with a chosen language", () => {
    expect(catalogLanguagesForInworld(["en", "es"], "fr-FR")).toEqual(["en", "es", "fr-FR"])
    expect(catalogLanguagesForInworld(["en", "French"], "fr-FR")).toEqual(["en", "fr-FR"])
  })

  it("uses the chosen language when no lane maps", () => {
    expect(catalogLanguagesForInworld(["French"], "fr-FR")).toEqual(["fr-FR"])
    expect(catalogLanguagesForInworld(["French"])).toEqual([])
  })
})

describe("inworldLanguageForRequest", () => {
  it("prefers the saved voice language over an unmapped lane", () => {
    expect(inworldLanguageForRequest({ language: "fr-FR" }, "French")).toBe("fr-FR")
  })

  it("falls back to a mapped lane when the voice has no language", () => {
    expect(inworldLanguageForRequest({}, "es")).toBe("es")
    expect(inworldLanguageForRequest({}, "French")).toBeUndefined()
  })
})

describe("isListedInworldLanguage", () => {
  it("is true only for the shortlist of stock Inworld languages", () => {
    expect(isListedInworldLanguage("fr-FR")).toBe(true)
    expect(isListedInworldLanguage("fra")).toBe(true)
    expect(isListedInworldLanguage("sv-SE")).toBe(false)
    expect(isListedInworldLanguage("French")).toBe(false)
  })
})

describe("formatInworldLanguageLabel", () => {
  it("includes the BCP-47 code next to the display name", () => {
    expect(formatInworldLanguageLabel("fr-FR", "en")).toMatch(/fr-FR/)
    expect(formatInworldLanguageLabel("fr-FR", "en")).toMatch(/French/i)
  })
})

describe("formatVoiceLanguageName", () => {
  it("returns the display name without the BCP-47 code", () => {
    expect(formatVoiceLanguageName("en-US", "en")).toMatch(/English/i)
    expect(formatVoiceLanguageName("en-US", "en")).not.toMatch(/en-US/)
    expect(formatVoiceLanguageName("fr-FR", "en")).toMatch(/French/i)
  })

  it("maps ISO-639-3 scripture codes before naming them", () => {
    expect(formatVoiceLanguageName("spa", "en")).toMatch(/Spanish/i)
  })

  it("canonicalizes a typed display name like french → French", () => {
    expect(formatVoiceLanguageName("french", "en")).toBe("French")
    expect(formatVoiceLanguageName("French", "en")).toBe("French")
  })

  it("returns an empty string for blank tags", () => {
    expect(formatVoiceLanguageName("", "en")).toBe("")
    expect(formatVoiceLanguageName("   ", "en")).toBe("")
  })
})

describe("languageForVoiceDescription", () => {
  it("prefers the voice's own language", () => {
    expect(languageForVoiceDescription("fr-FR", "en")).toBe("fr-FR")
  })

  it("falls back to the active target language when the voice has none", () => {
    expect(languageForVoiceDescription(undefined, "es")).toBe("es")
    expect(languageForVoiceDescription("  ", "French")).toBe("French")
  })

  it("is undefined when neither the voice nor the project has a language", () => {
    expect(languageForVoiceDescription(undefined, undefined)).toBeUndefined()
    expect(languageForVoiceDescription("  ", "")).toBeUndefined()
  })
})
