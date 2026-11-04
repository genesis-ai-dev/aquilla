import { describe, expect, it } from "vitest"
import { alignVersion, mapEnglishRef, psalmTitleOffset, versificationScheme } from "./versification"

describe("versification", () => {
  it.each([
    // [scheme, book, chapter, verse] → [chapter, verse, shifted]
    ["hebrew", "MAL", 4, 1, 3, 19, true],
    ["hebrew", "MAL", 4, 6, 3, 24, true],
    ["hebrew", "MAL", 4, null, 3, null, true],
    ["hebrew", "JOL", 2, 28, 3, 1, true],
    ["hebrew", "JOL", 2, 32, 3, 5, true],
    ["hebrew", "JOL", 2, 27, 2, 27, false],
    ["hebrew", "JOL", 3, 1, 4, 1, true],
    ["hebrew", "JON", 1, 17, 2, 1, true],
    ["hebrew", "MAL", 3, 18, 3, 18, false],
    ["english", "MAL", 4, 1, 4, 1, false],
  ] as const)("%s %s %s:%s → %s:%s", (scheme, book, chapter, verse, toChapter, toVerse, shifted) => {
    expect(mapEnglishRef(scheme, book, chapter, verse)).toEqual({ chapter: toChapter, verse: toVerse, shifted })
  })

  it("reads the scheme from the language and the psalm offset from the two chapters", () => {
    expect(versificationScheme("hbo")).toBe("hebrew")
    expect(versificationScheme("grc")).toBe("english")
    expect(versificationScheme(undefined)).toBe("english")
    // PSA 3: English carries the title unnumbered (8 verses), Hebrew numbers it (9).
    expect(psalmTitleOffset({ verseCount: 8, hasPsalmTitle: true }, 9)).toBe(1)
    expect(psalmTitleOffset({ verseCount: 19, hasPsalmTitle: true }, 21)).toBe(2) // PSA 51
    expect(psalmTitleOffset({ verseCount: 6, hasPsalmTitle: true }, 6)).toBe("unknown") // PSA 13
    expect(psalmTitleOffset({ verseCount: 6, hasPsalmTitle: false }, 6)).toBe(0)
    expect(psalmTitleOffset(undefined, 9)).toBe("unknown")
  })

  it("marks every column whose numbering does not line up", () => {
    const base = { book: "PSA", chapter: 3, verse: 2 }
    const bsb = { verseCount: 8, hasPsalmTitle: true, versionLabel: "BSB", isSelf: false }
    expect(alignVersion({ ...base, scheme: "hebrew", loaded: { verseCount: 9, hasPsalmTitle: false }, reference: bsb }))
      .toEqual({ chapter: 3, verse: 3, note: { kind: "psalmTitle", offset: 1 } })
    expect(alignVersion({ ...base, scheme: "hebrew", loaded: { verseCount: 9, hasPsalmTitle: false } }))
      .toEqual({ chapter: 3, verse: 2, note: { kind: "psalmUnsure" } })
    expect(alignVersion({ scheme: "hebrew", book: "MAL", chapter: 4, verse: 1 }))
      .toEqual({ chapter: 3, verse: 19, note: { kind: "shifted", here: "MAL 3:19", english: "MAL 4:1" } })
    // JOL 2 before the shifted run: Hebrew 27 verses vs English 32.
    expect(alignVersion({
      scheme: "hebrew", book: "JOL", chapter: 2, verse: 1,
      loaded: { verseCount: 27, hasPsalmTitle: false },
      reference: { verseCount: 32, hasPsalmTitle: false, versionLabel: "BSB", isSelf: false },
    }).note).toEqual({ kind: "countDiffers", count: 27, refCount: 32, refVersion: "BSB" })
    // The yardstick never flags itself, and matching counts say nothing.
    expect(alignVersion({
      scheme: "english", book: "JHN", chapter: 3, verse: 16,
      loaded: { verseCount: 36, hasPsalmTitle: false },
      reference: { verseCount: 36, hasPsalmTitle: false, versionLabel: "BSB", isSelf: false },
    }).note).toBeNull()
  })
})
