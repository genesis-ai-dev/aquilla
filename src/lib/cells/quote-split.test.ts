// AQU-1759. The seams a row splits at, across the quoting conventions
// scripture is published in. One table: each row is a passage and the pieces
// it must become — or a single piece, which means "leave this row alone".

import { describe, it, expect } from "vitest"
import { canSplitAtQuotes, splitAtQuotes } from "./quote-split"

const n = (text: string) => ({ kind: "narration" as const, text })
const q = (text: string) => ({ kind: "quote" as const, text })

describe("splitAtQuotes", () => {
  it.each([
    // The ticket's own case, John 6:5 in English.
    [
      "curly double, narration then speech",
      "Lifting up his eyes, then, and seeing that a large crowd was coming toward him, Jesus said to Philip, “Where are we to buy bread, so that these people may eat?”",
      [
        n("Lifting up his eyes, then, and seeing that a large crowd was coming toward him, Jesus said to Philip,"),
        q("“Where are we to buy bread, so that these people may eat?”"),
      ],
    ],
    [
      "speech, narration, speech",
      "“Yes,” he said, “go now.”",
      [q("“Yes,”"), n("he said,"), q("“go now.”")],
    ],
    ["straight double", 'Jesus said, "I am the bread of life." Then they left.', [n("Jesus said,"), q('"I am the bread of life."'), n("Then they left.")]],
    ["curly single as the primary quote", "Jesus said, ‘I am the bread of life.’", [n("Jesus said,"), q("‘I am the bread of life.’")]],
    [
      "an apostrophe inside a single-quoted speech does not end it",
      "‘Don’t be afraid,’ he said.",
      [q("‘Don’t be afraid,’"), n("he said.")],
    ],
    ["French guillemets with inner spaces", "Jésus leur dit : « Je suis le pain de vie. »", [n("Jésus leur dit :"), q("« Je suis le pain de vie. »")]],
    ["Danish »…«", "Jesus sagde: »Jeg er livets brød.« Så gik han.", [n("Jesus sagde:"), q("»Jeg er livets brød.«"), n("Så gik han.")]],
    ["Swedish »…»", "Jesus sade: »Jag är livets bröd.»", [n("Jesus sade:"), q("»Jag är livets bröd.»")]],
    ["Finnish ”…”", "Jeesus sanoi: ”Minä olen elämän leipä.”", [n("Jeesus sanoi:"), q("”Minä olen elämän leipä.”")]],
    ["German „…“", "Jesus sprach: „Ich bin das Brot des Lebens.“", [n("Jesus sprach:"), q("„Ich bin das Brot des Lebens.“")]],
    ["Polish „…”", "Jezus powiedział: „Ja jestem chlebem życia.”", [n("Jezus powiedział:"), q("„Ja jestem chlebem życia.”")]],
    ["CJK corner brackets", "耶稣对他们说：「我就是生命的粮。」", [n("耶稣对他们说："), q("「我就是生命的粮。」")]],
    // Nested quotes are one speaker reporting another: one seam, not two.
    [
      "nested single inside double",
      "He said, “Moses wrote, ‘He gave them bread from heaven.’ ” And they went.",
      [n("He said,"), q("“Moses wrote, ‘He gave them bread from heaven.’ ”"), n("And they went.")],
    ],
    [
      "German nested ‚…‘ inside „…“",
      "Er sprach: „Es steht geschrieben: ‚Brot vom Himmel.‘ Und so ist es.“",
      [n("Er sprach:"), q("„Es steht geschrieben: ‚Brot vom Himmel.‘ Und so ist es.“")],
    ],
    ["CJK nested 『』 inside 「」", "他说：「经上记着说：『他从天上赐下粮来。』」", [n("他说："), q("「经上记着说：『他从天上赐下粮来。』」")]],
    // Speech that crosses a verse boundary.
    [
      "an opener the row never closes runs to the end",
      "Jesus answered them, “Truly, truly, I say to you, you are seeking me,",
      [n("Jesus answered them,"), q("“Truly, truly, I say to you, you are seeking me,")],
    ],
    [
      "a closer with nothing open ends speech begun in the row above",
      "because you ate your fill of the loaves.” Then they said to him,",
      [q("because you ate your fill of the loaves.”"), n("Then they said to him,")],
    ],
    // A stop outside the closing mark rides with the speech, not on its own.
    ["punctuation after a closer is folded in", "He said, “Go”.", [n("He said,"), q("“Go”.")]],
    // USFM markup stays in an imported verse. It is invisible to the scanner
    // and travels with the quote it hugs.
    [
      "the words of Jesus move with their quote",
      "He said to Philip, \\wj “Where are we to buy bread?”\\wj* He said this to test him.",
      [n("He said to Philip,"), q("\\wj “Where are we to buy bread?”\\wj*"), n("He said this to test him.")],
    ],
    [
      "a footnote quoting a reading is not speech",
      "Jesus went up\\f + \\ft Or “went up”\\f* and said, “Sit.”",
      [n("Jesus went up\\f + \\ft Or “went up”\\f* and said,"), q("“Sit.”")],
    ],
    [
      "attribute quotes inside \\w are not speech",
      'He \\w said|strong="G3004"\\w*, “Come.”',
      [n('He \\w said|strong="G3004"\\w*,'), q("“Come.”")],
    ],
  ])("%s", (_label, text, pieces) => {
    expect(splitAtQuotes(text)).toEqual({ pieces, refusal: null })
  })

  it("refuses a seam that would cut markup in half", () => {
    // \\add opens in the narration and closes inside the speech: either cut
    // leaves one piece with an unclosed marker.
    const split = splitAtQuotes("Then \\add Jesus said, “Go\\add* now.”")
    expect(split.pieces.length).toBe(2)
    expect(split.refusal).toBe("markup")
    expect(canSplitAtQuotes("Then \\add Jesus said, “Go\\add* now.”")).toBe(false)
  })

  it.each([
    ["no quotation at all", "After this Jesus went away to the other side of the Sea of Galilee."],
    ["one speaker throughout", "“I am the bread of life; whoever comes to me shall not hunger.”"],
    ["speech continuing from above, closed at the end", "Do not work for the food that perishes, but for the food that endures.”"],
    ["apostrophes only", "Peter’s brother Andrew didn’t say anything."],
    ["empty", ""],
  ])("leaves %s alone", (_label, text) => {
    expect(splitAtQuotes(text).pieces.length).toBeLessThanOrEqual(1)
    expect(canSplitAtQuotes(text)).toBe(false)
  })
})
