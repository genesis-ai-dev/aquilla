import { describe, expect, it } from "vitest"
import type { HelloaoTranslation } from "@/lib/parsers/helloao"
import { resolveBibleCell } from "./bible-cells"
import { chapterKey, type ChapterData } from "./chapter-data"
import { bibleColumnsLayout } from "./EditorBibleColumns"

function chapter(from: number, to: number, label: string): ChapterData {
  const verses = new Map<number, string>()
  for (let v = from; v <= to; v++) verses.set(v, `${label} ${v}`)
  return { verses, blocks: [], shape: { verseCount: verses.size, hasPsalmTitle: false } }
}

const WLC = { id: "hbo_wlc", language: "hbo", textDirection: "rtl" } as HelloaoTranslation
const BSB = { id: "BSB", language: "eng", textDirection: "ltr" } as HelloaoTranslation

describe("resolveBibleCell", () => {
  const data = new Map<string, ChapterData>([
    [chapterKey("hbo_wlc", "MAL", 3), chapter(1, 24, "WLC 3")],
    [chapterKey("BSB", "GEN", 1), chapter(1, 31, "BSB 1")],
  ])

  it("shows Hebrew 3:19 on an English MAL 4:1 row, and says so", () => {
    expect(resolveBibleCell({ versionId: "hbo_wlc", meta: WLC, row: { kind: "verses", book: "MAL", chapter: 4, from: 1, to: 1 }, chapterData: data, reference: undefined }))
      .toEqual({ state: "text", verses: [{ number: 19, text: "WLC 3 19" }], note: { kind: "shifted", here: "MAL 3:19", english: "MAL 4:1" } })
  })

  it("joins a range, waits for an unloaded chapter, and marks continued parts", () => {
    expect(resolveBibleCell({ versionId: "BSB", meta: BSB, row: { kind: "verses", book: "GEN", chapter: 1, from: 1, to: 3 }, chapterData: data, reference: undefined }))
      .toEqual({ state: "text", verses: [1, 2, 3].map((n) => ({ number: n, text: `BSB 1 ${n}` })), note: null })
    expect(resolveBibleCell({ versionId: "BSB", meta: BSB, row: { kind: "verses", book: "JHN", chapter: 3, from: 16, to: 16 }, chapterData: data, reference: undefined }))
      .toEqual({ state: "loading" })
    expect(resolveBibleCell({ versionId: "BSB", meta: BSB, row: { kind: "continued" }, chapterData: data, reference: undefined }))
      .toEqual({ state: "continued" })
    expect(resolveBibleCell({ versionId: "BSB", meta: BSB, row: { kind: "verses", book: "GEN", chapter: 1, from: 40, to: 40 }, chapterData: data, reference: undefined }))
      .toEqual({ state: "missing", ref: "GEN 1:40", note: null })
  })
})

describe("bibleColumnsLayout", () => {
  it.each([
    [1400, 0, "none"],
    [1400, 2, "columns"],
    [1400, 3, "columns"],
    [1400, 4, "stacked"], // more than three never becomes columns
    [900, 3, "stacked"], // the target would fall under the minimum width
    [700, 1, "stacked"], // phones and the two-track grid
  ] as const)("%spx with %s Bibles → %s", (width, count, layout) => {
    expect(bibleColumnsLayout(width, 84, count)).toBe(layout)
  })
})
