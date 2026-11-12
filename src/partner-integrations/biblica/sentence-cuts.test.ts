import { describe, expect, it } from "vitest"
import { biblicaSentenceCutPoints } from "./sentence-cuts"

/** Slice the text the way `sliceIdmlUnit` will, so tests read as the cells do. */
function slices(text: string): string[] {
  const cuts = biblicaSentenceCutPoints(text)
  const bounds = [0, ...cuts, text.length]
  return bounds.slice(0, -1).map((start, index) => text.slice(start, bounds[index + 1]))
}

describe("biblicaSentenceCutPoints", () => {
  it("cuts a note block into one sentence per cell", () => {
    const text = "3:1–7 The serpent's temptation of the woman. Satan is not named in"
      + " this passage, but Rev 12:9 identifies him. The woman's reply adds to what"
      + " God had actually commanded her."

    expect(biblicaSentenceCutPoints(text)).toEqual([
      text.indexOf("Satan"),
      text.indexOf("The woman's"),
    ])
    expect(slices(text)).toEqual([
      "3:1–7 The serpent's temptation of the woman. ",
      "Satan is not named in this passage, but Rev 12:9 identifies him. ",
      "The woman's reply adds to what God had actually commanded her.",
    ])
  })

  it("keeps the sentence's own closing punctuation and opens the next with its quote", () => {
    const text = 'The psalmist asks the Lord, "How long will you hide your face from me?"'
      + " He is not doubting the promise God gave him earlier."
      + ' ("Selah" marks a pause for reflection in the psalm.)'

    expect(slices(text)).toEqual([
      'The psalmist asks the Lord, "How long will you hide your face from me?" ',
      "He is not doubting the promise God gave him earlier. ",
      '("Selah" marks a pause for reflection in the psalm.)',
    ])
  })

  it("does not cut where study-note prose is ambiguous", () => {
    for (const text of [
      // Reference and scholarly abbreviations.
      "Paul argues from the covenant sign (cf. Rom 4:11) rather than from the law itself in this section of the letter.",
      "The Hebrew here is uncertain; lit. \"he covered his feet,\" a euphemism the translators of the day softened considerably.",
      // An initial in a cited name.
      "The reading follows that of F. F. Bruce against the majority of the earlier commentators on this passage.",
      // A bare chapter number reads exactly like an enumerator.
      "The promise is repeated in Genesis 15. Abram believed it and it was credited to him as righteousness.",
      // A decimal, and a verse letter with no space after the mark.
      "Roughly 2.5 million people are in view, which is more than the region could plausibly have supported then.",
    ]) {
      expect(biblicaSentenceCutPoints(text)).toEqual([])
    }
  })

  it("leaves short notes and short trailing sentences whole", () => {
    // Both halves under one slice: not worth two cells.
    expect(biblicaSentenceCutPoints("See 2:4. It is repeated.")).toEqual([])
    // A long opening sentence with a short remark after it stays one cell.
    expect(biblicaSentenceCutPoints(
      "The genealogy resumes the account broken off at the end of the previous chapter. So also 11:10.",
    )).toEqual([])
    expect(biblicaSentenceCutPoints("")).toEqual([])
  })

  it("splits a long note at every boundary that earns a cell", () => {
    const sentence = (ordinal: string) => (
      `${ordinal} sentence of a long note that comments on the passage at hand. `
    )
    const text = `${sentence("First")}${sentence("Second")}${sentence("Third")}`.trimEnd()

    expect(slices(text)).toEqual([
      sentence("First"),
      sentence("Second"),
      sentence("Third").trimEnd(),
    ])
  })
})
