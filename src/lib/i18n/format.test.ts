import { describe, expect, it } from "vitest"
import {
  BIDI_FSI,
  BIDI_PDI,
  bidiIsolate,
  formatBytesProgress,
  formatCount,
  formatDate,
  formatList,
  formatMB,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
} from "./format"
import { pluralCountFrom } from "./plurals"

const SAMPLE = new Date(2026, 7, 12, 15, 30) // Aug 12 2026, 3:30pm local

describe("formatDate", () => {
  it("renders a real difference between locales, not just a non-empty string", () => {
    // The bug this module fixes: `toLocaleDateString()` with no locale uses
    // the *browser's* language. A correct fix must render Arabic UI with an
    // Arabic-formatted date, distinguishably different from the English one
    // — a test that only checks "returns a string" can't catch a regression
    // back to a hardcoded/browser locale.
    const en = formatDate(SAMPLE, "en", { dateStyle: "long" })
    const ar = formatDate(SAMPLE, "ar", { dateStyle: "long" })
    expect(en).not.toBe(ar)
    expect(en).toContain("2026")
    // Arabic-locale month/weekday names use Arabic script, not Latin.
    expect(/[؀-ۿ]/.test(ar)).toBe(true)
  })

  it("is stable for the same locale and value", () => {
    expect(formatDate(SAMPLE, "en")).toBe(formatDate(SAMPLE, "en"))
  })
})

describe("formatTime", () => {
  it("differs between en and ar formatting of the same instant", () => {
    const en = formatTime(SAMPLE, "en")
    const ar = formatTime(SAMPLE, "ar")
    expect(en).not.toBe(ar)
  })
})

describe("formatRelativeTime", () => {
  it("renders locale-appropriate relative phrasing, not just English words", () => {
    const now = SAMPLE.getTime()
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000
    const en = formatRelativeTime(threeDaysAgo, "en", now)
    const ar = formatRelativeTime(threeDaysAgo, "ar", now)
    expect(en.toLowerCase()).toContain("day")
    expect(en).not.toBe(ar)
    expect(/[؀-ۿ]/.test(ar)).toBe(true)
  })
})

describe("formatNumber / formatPercent", () => {
  it("uses locale-appropriate grouping/decimal marks", () => {
    // German groups with "." and decimals with "," — a distinctive, checkable
    // difference from the en-US "1,234.5" shape.
    expect(formatNumber(1234.5, "en")).toBe("1,234.5")
    expect(formatNumber(1234.5, "de")).toBe("1.234,5")
  })

  it("renders a percent sign and rounds by default", () => {
    expect(formatPercent(0.314, "en")).toBe("31%")
  })
})

describe("formatCount (plural-interpolation safety)", () => {
  it("always renders ASCII digits so pluralCountFrom can recover the magnitude", () => {
    // pluralCountFrom strips non-[0-9] characters to read back the count that
    // drove plural-category selection. If formatCount ever rendered native
    // (e.g. Eastern Arabic) digits, the stripped string would be empty and
    // every count-governed Arabic message would silently fall back to the
    // "other" category.
    const rendered = formatCount(1234, "ar")
    expect(pluralCountFrom({ count: rendered }, "count")).toBe(1234)
  })
})

describe("formatMB / formatBytesProgress", () => {
  it("keeps MB as an invariant SI symbol but localizes the number", () => {
    expect(formatMB(40 * 1024 * 1024, "en")).toBe("40.0 MB")
    expect(formatMB(1234.5 * 1024 * 1024, "de")).toBe("1.234,5 MB")
  })

  it("matches the historical AQU-520 shape for the default locale", () => {
    const MB = 1024 * 1024
    expect(formatBytesProgress(12.4 * MB, 40 * MB, "en")).toBe("12.4 / 40.0 MB (31%)")
    expect(formatBytesProgress(12.4 * MB, undefined, "en")).toBe("12.4 MB")
  })
})

describe("formatList", () => {
  it("joins with the target locale's own separator/conjunction, not a hardcoded comma", () => {
    const items = ["source language", "target language"]
    expect(formatList(items, "en")).toBe("source language, target language")
    // A locale-blind `.join(", ")` would render this identically for every
    // locale; ListFormat must actually consult the locale's list pattern.
    expect(formatList(items, "en", { type: "conjunction" })).toBe(
      "source language and target language",
    )
    expect(formatList(items, "ar", { type: "conjunction" })).not.toBe(
      formatList(items, "en", { type: "conjunction" }),
    )
  })
})

describe("bidiIsolate", () => {
  it("wraps the value in FSI/PDI so it can't be reordered by the bidi algorithm", () => {
    expect(bidiIsolate("2/4")).toBe(`${BIDI_FSI}2/4${BIDI_PDI}`)
    expect(bidiIsolate(12)).toBe(`${BIDI_FSI}12${BIDI_PDI}`)
  })
})
