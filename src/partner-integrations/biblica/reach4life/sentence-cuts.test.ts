import { describe, expect, it } from "vitest"
import { treasureHuntSentenceCutPoints } from "../treasure-hunt/sentence-cuts"
import { reach4LifeSentenceCutPoints } from "./sentence-cuts"

/** The slices `cuts` describes, so expectations read as the sentences a translator sees. */
function slices(text: string, cuts: readonly number[]): string[] {
  return [...cuts, text.length].map((end, index) => (
    text.slice(index === 0 ? 0 : cuts[index - 1]!, end)
  ))
}

describe("reach4LifeSentenceCutPoints", () => {
  it("cuts a lesson block into one slice per sentence", () => {
    const text = "When you look at yourself in the mirror, what do you see? "
      + "Do you sometimes feel your family does not know the real you? "
      + "There is a much better way to find out who you are: ask the one who made you."

    expect(slices(text, reach4LifeSentenceCutPoints(text))).toEqual([
      "When you look at yourself in the mirror, what do you see? ",
      "Do you sometimes feel your family does not know the real you? ",
      "There is a much better way to find out who you are: ask the one who made you.",
    ])
  })

  it("leaves an enumerator at the head of its own step, never on the previous one", () => {
    // Reach4Life sets numbered advice as one paragraph. Breaking after "2. "
    // would strand the enumerator on the end of the previous cell and open the
    // next one mid-step; breaking before it is what a translator wants.
    const text = "1. Listen to them without judging what they say. "
      + "This is how we show the person that we really do care about them. "
      + "2. Watch for the signs that someone close to you is struggling badly."

    expect(slices(text, reach4LifeSentenceCutPoints(text))).toEqual([
      "1. Listen to them without judging what they say. ",
      "This is how we show the person that we really do care about them. ",
      "2. Watch for the signs that someone close to you is struggling badly.",
    ])
  })

  it("never breaks after a bare number, which the Treasure Hunt cutter does", () => {
    // The Treasure Hunt cutter accepts that break because its copy names
    // passages in running prose ("read Genesis 4. Before that …"). Reach4Life
    // sets references in parentheses or on their own line, so here a trailing
    // number is far likelier to be a page cross-link or a list marker.
    const text = "Read the whole Gospel of Mark, which starts on Bpg 41. "
      + "Then read Acts, which tells the story of the very first church."

    expect(reach4LifeSentenceCutPoints(text)).toEqual([])
    expect(slices(text, treasureHuntSentenceCutPoints(text))).toEqual([
      "Read the whole Gospel of Mark, which starts on Bpg 41. ",
      "Then read Acts, which tells the story of the very first church.",
    ])
  })

  it("keeps a parenthesised reference with the sentence that cites it", () => {
    const text = "It is because God created us in his own likeness (Genesis 1:27). "
      + "As humans, we are unique works of art designed by the God of the universe."

    expect(slices(text, reach4LifeSentenceCutPoints(text))).toEqual([
      "It is because God created us in his own likeness (Genesis 1:27). ",
      "As humans, we are unique works of art designed by the God of the universe.",
    ])
  })

  it("leaves the workbook's page cross-references whole", () => {
    const text = "Discover and ignite your faith in The story on Rpg 22. "
      + "Then explore all 27 New Testament books, which start on Bpg 1."

    expect(slices(text, reach4LifeSentenceCutPoints(text))).toEqual([
      "Discover and ignite your faith in The story on Rpg 22. "
        + "Then explore all 27 New Testament books, which start on Bpg 1.",
    ])
  })

  it("does not split an abbreviation that ends a clause", () => {
    const text = "Some struggles — addiction, bullying, self-harm, etc. — feel impossible. "
      + "There is always someone you can talk to who will help you find a way through."

    expect(slices(text, reach4LifeSentenceCutPoints(text))).toEqual([
      "Some struggles — addiction, bullying, self-harm, etc. — feel impossible. ",
      "There is always someone you can talk to who will help you find a way through.",
    ])
  })

  it("keeps a short paragraph whole rather than paying a cell for a fragment", () => {
    expect(reach4LifeSentenceCutPoints("Sex is a gift from God. Are you in?")).toEqual([])
    expect(reach4LifeSentenceCutPoints("God is listening \u2026")).toEqual([])
  })

  it("cuts only where a new sentence really starts", () => {
    // A decimal, an ellipsis mid-sentence and a lower-case continuation are all
    // places a naive scan would break.
    const text = "And then you justify your actions with excuses like \u2026 everyone else "
      + "is doing it, so how bad can it really be? "
      + "Take a closer look at that list, because none of those reasons are healthy values."

    expect(slices(text, reach4LifeSentenceCutPoints(text))).toEqual([
      "And then you justify your actions with excuses like \u2026 everyone else "
        + "is doing it, so how bad can it really be? ",
      "Take a closer look at that list, because none of those reasons are healthy values.",
    ])
  })
})
