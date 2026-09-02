import { describe, expect, it } from "vitest"
import { biblicaSentenceCutPoints } from "../sentence-cuts"
import { treasureHuntSentenceCutPoints } from "./sentence-cuts"

/** The slices `cuts` describes, so expectations read as the sentences a translator sees. */
function slices(text: string, cuts: readonly number[]): string[] {
  return [...cuts, text.length].map((end, index) => (
    text.slice(index === 0 ? 0 : cuts[index - 1]!, end)
  ))
}

describe("treasureHuntSentenceCutPoints", () => {
  it("cuts a fact block into one slice per sentence", () => {
    const text = "To create something means to make something new. "
      + "It means to make something that did not exist before. "
      + "That is exactly what God did when he created the heavens and the earth."

    expect(slices(text, treasureHuntSentenceCutPoints(text))).toEqual([
      "To create something means to make something new. ",
      "It means to make something that did not exist before. ",
      "That is exactly what God did when he created the heavens and the earth.",
    ])
  })

  it("cuts after a passage named in running prose, which the study cutter will not", () => {
    const text = "Adam\u2019s name is first used in Genesis 4. "
      + "Before that he is just simply called the man. "
      + "Adam\u2019s name is like the Hebrew word for dirt, adamah."

    expect(slices(text, treasureHuntSentenceCutPoints(text))).toEqual([
      "Adam\u2019s name is first used in Genesis 4. ",
      "Before that he is just simply called the man. ",
      "Adam\u2019s name is like the Hebrew word for dirt, adamah.",
    ])
    // A study Bible sets that reference as a citation ("Genesis 4."), so its
    // cutter refuses the first boundary and hands over a larger first cell.
    expect(slices(text, biblicaSentenceCutPoints(text))).toEqual([
      "Adam\u2019s name is first used in Genesis 4. Before that he is just simply called the man. ",
      "Adam\u2019s name is like the Hebrew word for dirt, adamah.",
    ])
  })

  it("leaves a numbered list item joined to the text it introduces", () => {
    const text = "1. Go deep in the Bible and find out what God wants to say to you today."

    expect(treasureHuntSentenceCutPoints(text)).toEqual([])
  })

  it("cuts after a question, which this material asks constantly", () => {
    const text = "Why do you think Adam decided to hide himself from God? "
      + "Draw a face to show how Adam might have felt that day."

    expect(slices(text, treasureHuntSentenceCutPoints(text))).toEqual([
      "Why do you think Adam decided to hide himself from God? ",
      "Draw a face to show how Adam might have felt that day.",
    ])
  })

  it("keeps a verse reference whole", () => {
    const text = "You can read all about what happened next in James 1:2\u201318. "
      + "Then talk about it with someone in your group."

    expect(slices(text, treasureHuntSentenceCutPoints(text))).toEqual([
      "You can read all about what happened next in James 1:2\u201318. ",
      "Then talk about it with someone in your group.",
    ])
  })

  it("does not cut after an abbreviation or an initial", () => {
    const text = "Bring paint, cotton balls, paper towels, etc. and put them on the table "
      + "so that everyone in the group can reach them easily."

    expect(treasureHuntSentenceCutPoints(text)).toEqual([])
  })

  it("keeps a short note whole rather than splitting off a fragment", () => {
    const text = "Who lives in you? God does."

    expect(treasureHuntSentenceCutPoints(text)).toEqual([])
  })

  it("tiles the whole text, so the exporter can rebuild the paragraph", () => {
    const text = "Noah worked on the ark for a very long time indeed. "
      + "We do not know how old he was when the Lord told him to build it. "
      + "But he was 600 years old when he finished building it."
    const cuts = treasureHuntSentenceCutPoints(text)

    expect(cuts.length).toBeGreaterThan(0)
    expect(slices(text, cuts).join("")).toBe(text)
    expect([...cuts]).toEqual([...cuts].sort((a, b) => a - b))
  })
})
