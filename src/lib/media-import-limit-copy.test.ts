import { describe, expect, it } from "vitest"
import { CATALOGS } from "./i18n/messages"
import { en } from "./i18n/messages/en"
import { LOCALES } from "./i18n/locales"
import { translate } from "./i18n/translate"
import { formatByteLimit } from "./i18n/format"
import { MAX_AUDIO_OBJECT_BYTES, MAX_AUDIO_UPLOAD_BYTES } from "./audio/upload"

/**
 * Regression guard for AQU-1975.
 *
 * AQU-1853 raised the media import ceiling from 95 MB to 2 GB but left the
 * refusal copy quoting the old number, so a user who had just uploaded 500 MB
 * was told the limit was 95 MB. The copy must read the ceiling from
 * `MAX_AUDIO_OBJECT_BYTES` instead of naming it, in every locale, so it cannot
 * drift again the next time the cap moves.
 */

const KEY = "importExport.errors.mediaFileTooLarge" as const

describe("media import limit copy", () => {
  it("renders the live ceiling rather than a hardcoded number", () => {
    const rendered = translate(en, KEY, {
      fileName: "sermon.mp4",
      limit: formatByteLimit(MAX_AUDIO_OBJECT_BYTES, "en"),
    }, "en")
    expect(rendered).toBe("sermon.mp4 exceeds the 2 GB media import limit.")
  })

  it("tracks the constant if the ceiling moves again", () => {
    const doubled = MAX_AUDIO_OBJECT_BYTES * 2
    expect(translate(en, KEY, { fileName: "a.mp4", limit: formatByteLimit(doubled, "en") }, "en"))
      .toContain("4 GB")
  })

  it.each(LOCALES.map((l) => [l.code] as const))(
    "%s neither quotes 95 MB nor drops the {limit} placeholder",
    (code) => {
      const value = (CATALOGS[code] as Record<string, string | undefined> | undefined)?.[KEY]
      if (value === undefined) return // absent key falls back to English (AQU-511)
      expect(value).toContain("{limit}")
      // Latin and Cyrillic unit symbols, and the Arabic/Burmese spellings.
      expect(value).not.toMatch(/95\s*(MB|Mo|МБ|ميغابايت|မက်ဂါဘိုက်)/i)
      expect(value).not.toContain("95")
    },
  )

  it("leaves the live recorder's own 95 MB capture bound alone", () => {
    // AQU-1975 moved the import copy only; MAX_AUDIO_UPLOAD_BYTES is a real,
    // separate limit (single-request PUT / recorder memory budget).
    expect(MAX_AUDIO_UPLOAD_BYTES).toBe(95 * 1024 * 1024)
    expect(MAX_AUDIO_OBJECT_BYTES).toBeGreaterThan(MAX_AUDIO_UPLOAD_BYTES)
  })
})
