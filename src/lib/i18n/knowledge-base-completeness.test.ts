import { describe, expect, it } from "vitest"
import { LOCALES } from "./locales"
import { CATALOGS } from "./messages"
import { en, type MessageKey } from "./messages/en"

const KB_KEYS = (Object.keys(en) as MessageKey[]).filter((key) =>
  key.startsWith("knowledgeBase."),
)

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
    .map((match) => match[1])
    .sort()
}

describe("Knowledge Base locale completeness", () => {
  it("keeps an explicit non-English translation for every KB message", () => {
    expect(KB_KEYS.length).toBeGreaterThan(0)

    for (const locale of LOCALES.filter(({ code }) => code !== "en")) {
      const catalog = CATALOGS[locale.code]
      const missing = KB_KEYS.filter((key) => catalog[key] === undefined)
      expect(missing, `${locale.code} is missing Knowledge Base translations`).toEqual([])

      for (const key of KB_KEYS) {
        const translated = catalog[key]
        const source = en[key]
        expect(typeof translated, `${locale.code}:${key} must be a plain message`).toBe("string")
        expect(translated, `${locale.code}:${key} still falls back to English`).not.toBe(source)
        expect(
          placeholders(translated as string),
          `${locale.code}:${key} changed its placeholders`,
        ).toEqual(placeholders(source as string))
      }
    }
  })
})
