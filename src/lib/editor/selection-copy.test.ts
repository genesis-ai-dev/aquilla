import { describe, expect, it } from "vitest"

import { formatSelectionCopy } from "./selection-copy"

const verse = (
  number: string,
  text: string,
  chapter = "GEN 1",
  chapterLabel = "Genesis 1",
) => ({ number, chapter, chapterLabel, text })

describe("formatSelectionCopy", () => {
  it("writes one paragraph per line, in order, for Word", () => {
    const cases: { name: string; lines: Parameters<typeof formatSelectionCopy>[0]; text: string; html: string }[] = [
      {
        name: "one chapter has no chapter heading",
        lines: [verse("1", "In the beginning"), verse("2", "And the earth")],
        text: "1 In the beginning\n2 And the earth",
        html: "<p>1 In the beginning</p><p>2 And the earth</p>",
      },
      {
        name: "a chapter boundary is named so verse numbers stay unambiguous",
        lines: [
          verse("1", "In the beginning"),
          verse("1", "Thus the heavens", "GEN 2", "Genesis 2"),
        ],
        text: "Genesis 1\n1 In the beginning\nGenesis 2\n1 Thus the heavens",
        html: "<p>Genesis 1</p><p>1 In the beginning</p><p>Genesis 2</p><p>1 Thus the heavens</p>",
      },
      {
        name: "a heading has no verse number, and an empty line is left out",
        lines: [
          { number: null, chapter: null, chapterLabel: null, text: "The Creation" },
          verse("3", "   "),
          verse("4", "And God saw"),
        ],
        text: "The Creation\n4 And God saw",
        html: "<p>The Creation</p><p>4 And God saw</p>",
      },
      {
        name: "markup in the text is escaped in the HTML clipboard",
        lines: [verse("1", "a < b & c")],
        text: "1 a < b & c",
        html: "<p>1 a &lt; b &amp; c</p>",
      },
    ]
    for (const entry of cases) {
      const formatted = formatSelectionCopy(entry.lines)
      expect(formatted.text, entry.name).toBe(entry.text)
      expect(formatted.html, entry.name).toBe(entry.html)
    }
  })
})
