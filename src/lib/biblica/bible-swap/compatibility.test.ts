/**
 * The compatibility report is what a user reads before committing to a swap, so
 * the numbers have to mean what the labels say: books/chapters/verses actually
 * found in the chosen Bible, the worst-mismatched books first, and a projected
 * match derived from the same versification plan the swap will apply.
 */

import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import {
  analyzeBibleSwapCompatibility,
  loadStoryXmlFromIdmlBytes,
  scoreBibleSwapCompatibility,
} from "./compatibility"

const NO_STYLE = "CharacterStyle/$ID/[No character style]"

function verse(chapter: string, verseNo: string, text: string): string {
  const chapterMarker =
    verseNo === "1"
      ? `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3ac"><Content>${chapter}:</Content></CharacterStyleRange>`
      : ""
  return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/text%3ap">
  ${chapterMarker}
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/cv%3av"><Content>${verseNo}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>${verseNo}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${text}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>${verseNo}</Content></CharacterStyleRange>
</ParagraphStyleRange>`
}

function story(book: string, body: string): string {
  return `<?xml version="1.0"?><Story>
<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/meta%3abk">
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${book}</Content></CharacterStyleRange>
</ParagraphStyleRange>${body}</Story>`
}

async function idmlWith(stories: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("mimetype", "application/vnd.adobe.indesign-idml-package")
  for (const [name, xml] of Object.entries(stories)) zip.file(name, xml)
  return zip.generateAsync({ type: "uint8array" })
}

describe("scoreBibleSwapCompatibility", () => {
  it("counts a fully aligned Bible as complete coverage", () => {
    const body = verse("1", "1", "one") + verse("1", "2", "two")
    const report = scoreBibleSwapCompatibility("bible.idml", story("JOS", body), [
      story("JOS", body),
    ])

    expect(report.booksExpected).toBe(1)
    expect(report.booksFound).toBe(1)
    expect(report.chaptersExpected).toBe(1)
    expect(report.chaptersFound).toBe(1)
    expect(report.versesExpected).toBe(2)
    expect(report.versesMatched).toBe(2)
    expect(report.perBookMismatches).toEqual([])
    expect(report.versificationPlan?.projectedVerseMatchPercent).toBe(100)
  })

  it("reports verses the Bible is missing and extras it adds", () => {
    const study = story("JOS", verse("1", "1", "one") + verse("1", "2", "two"))
    const bible = story("JOS", verse("1", "1", "um") + verse("1", "3", "tres"))

    const report = scoreBibleSwapCompatibility("bible.idml", bible, [study])

    expect(report.versesExpected).toBe(2)
    expect(report.versesMatched).toBe(1)
    expect(report.perBookMismatches).toEqual([{ book: "JOS", missing: 1, extra: 1 }])
  })

  it("counts a book absent from the Bible as found-zero", () => {
    const study = story("RUT", verse("1", "1", "one"))
    const bible = story("JOS", verse("1", "1", "um"))

    const report = scoreBibleSwapCompatibility("bible.idml", bible, [study])

    expect(report.booksExpected).toBe(1)
    expect(report.booksFound).toBe(0)
    expect(report.versesMatched).toBe(0)
    expect(report.chaptersFound).toBe(0)
  })

  it("orders mismatched books worst-first", () => {
    const study = [
      story("JOS", verse("1", "1", "a") + verse("1", "2", "b") + verse("1", "3", "c")),
      story("RUT", verse("1", "1", "a")),
    ]
    const bible = story("JOS", verse("1", "1", "um"))

    const report = scoreBibleSwapCompatibility("bible.idml", bible, study)

    expect(report.perBookMismatches.map((m) => m.book)).toEqual(["JOS", "RUT"])
  })

  it("flags Psalms so the caller can explain the verse shift", () => {
    const psalms = story("PSA", verse("23", "1", "a"))

    expect(scoreBibleSwapCompatibility("b.idml", psalms, [psalms]).hasPsalms).toBe(true)
    expect(
      scoreBibleSwapCompatibility("b.idml", story("JOS", verse("1", "1", "a")), [
        story("JOS", verse("1", "1", "a")),
      ]).hasPsalms,
    ).toBe(false)
  })

  it("merges coverage across several study volumes", () => {
    const bible = story("JOS", verse("1", "1", "um") + verse("1", "2", "dois"))
    const volumes = [
      story("JOS", verse("1", "1", "one")),
      story("JOS", verse("1", "2", "two")),
    ]

    const report = scoreBibleSwapCompatibility("bible.idml", bible, volumes)

    expect(report.versesExpected).toBe(2)
    expect(report.versesMatched).toBe(2)
  })

  it("omits the versification plan when nothing is being exported", () => {
    const report = scoreBibleSwapCompatibility(
      "bible.idml",
      story("JOS", verse("1", "1", "um")),
      [],
    )

    expect(report.versificationPlan).toBeUndefined()
    expect(report.versesExpected).toBe(0)
  })
})

describe("analyzeBibleSwapCompatibility", () => {
  it("reads Story XML out of real IDML archives and reports progress", async () => {
    const body = verse("1", "1", "one") + verse("1", "2", "two")
    const bibleIdml = await idmlWith({ "Stories/Story_b.xml": story("JOS", body) })
    const studyIdml = await idmlWith({ "Stories/Story_s.xml": story("JOS", body) })
    const stages: string[] = []

    const report = await analyzeBibleSwapCompatibility(
      "portuguese.idml",
      bibleIdml,
      [{ fileName: "JOS-EST.idml", idmlData: studyIdml }],
      (p) => stages.push(p.stage),
    )

    expect(report.bibleFileName).toBe("portuguese.idml")
    expect(report.versesMatched).toBe(2)
    expect(stages).toEqual(["loading", "indexing", "summarizing"])
  })

  it("skips an unreadable study volume instead of failing the report", async () => {
    const body = verse("1", "1", "one")
    const bibleIdml = await idmlWith({ "Stories/Story_b.xml": story("JOS", body) })
    const studyIdml = await idmlWith({ "Stories/Story_s.xml": story("JOS", body) })

    const report = await analyzeBibleSwapCompatibility("bible.idml", bibleIdml, [
      { fileName: "good.idml", idmlData: studyIdml },
      { fileName: "corrupt.idml", idmlData: new Uint8Array([1, 2, 3, 4]) },
    ])

    expect(report.versesExpected).toBe(1)
    expect(report.versesMatched).toBe(1)
  })

  it("names the offending file when the Bible is not an IDML", async () => {
    await expect(
      analyzeBibleSwapCompatibility("notes.txt", new Uint8Array([1, 2, 3, 4]), []),
    ).rejects.toThrow(/"notes\.txt" is not a valid IDML/)
  })
})

describe("loadStoryXmlFromIdmlBytes", () => {
  it("picks the largest story in the package", async () => {
    const idml = await idmlWith({
      "Stories/Story_small.xml": story("JOS", verse("1", "1", "x")),
      "Stories/Story_big.xml": story(
        "JOS",
        verse("1", "1", "a longer verse body that wins on size") + verse("1", "2", "b"),
      ),
    })

    const xml = await loadStoryXmlFromIdmlBytes(idml, "sample.idml")

    expect(xml).toContain("a longer verse body that wins on size")
  })

  it("rejects an archive with no stories", async () => {
    const idml = await idmlWith({})

    await expect(loadStoryXmlFromIdmlBytes(idml, "empty.idml")).rejects.toThrow(
      /No Stories\/\*\.xml entries found/,
    )
  })
})
