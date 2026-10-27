import { describe, expect, it } from "vitest"
import {
  distributeTranslationLikeSource,
  targetDistributionCollapsesSource,
  type SourceDistributionSlot,
} from "./segment-distribution"

const plain = "CharacterStyle/$ID/[No character style]"

describe("source segment distribution", () => {
  it("keeps a headword, the body, and the cross-reference in the source runs", () => {
    const slots: SourceDistributionSlot[] = [
      { index: 0, style: "CharacterStyle/k", text: "Devil:" },
      { index: 1, style: plain, text: " The leader of all evil spiritual beings. (" },
      { index: 2, style: "CharacterStyle/source serif", text: "\u02BC" },
      { index: 3, style: plain, text: "s power. (" },
      { index: 10, style: "CharacterStyle/k_xt", text: "Evil spiritual beings" },
      { index: 11, style: plain, text: " " },
      { index: 12, style: "CharacterStyle/xt", text: "Genesis 3:1–24" },
      { index: 13, style: plain, text: ".)" },
    ]
    const translation = "Diabo: O líder. (Seres espirituais maus Gênesis 3.1–24.)"
    const collapsed = new Map<number, string>([[0, translation]])

    expect(targetDistributionCollapsesSource(slots, collapsed)).toBe(true)
    expect(distributeTranslationLikeSource(slots, translation)).toEqual(new Map([
      [0, "Diabo:"],
      [1, " O líder. ("],
      [2, ""],
      [3, ""],
      [10, "Seres espirituais maus"],
      [11, " "],
      [12, "Gênesis 3.1–24"],
      [13, ".)"],
    ]))
  })

  it("keeps a leading verse span in its run and the note body in the plain run", () => {
    const slots: SourceDistributionSlot[] = [
      { index: 0, style: "CharacterStyle/bd", text: "1:1 – 2:25" },
      { index: 1, style: plain, text: " " },
      { index: 2, style: "CharacterStyle/k_xt", text: "God" },
      { index: 3, style: plain, text: " made a covenant." },
    ]
    const translation = "1.1 – 2.25 Deus fez uma aliança."

    expect(distributeTranslationLikeSource(slots, translation)).toEqual(new Map([
      [0, "1.1 – 2.25"],
      [1, " "],
      [2, ""],
      [3, "Deus fez uma aliança."],
    ]))
  })

  it("leaves an apostrophe split in the first plain run", () => {
    const slots: SourceDistributionSlot[] = [
      { index: 0, style: plain, text: "God" },
      { index: 1, style: "CharacterStyle/source serif", text: "\u02BC" },
      { index: 2, style: plain, text: "s covenant with the Israelites." },
    ]
    const translation = "A aliança de Deus com os israelitas."
    const placed = new Map<number, string>([[0, translation], [1, ""], [2, ""]])

    expect(targetDistributionCollapsesSource(slots, placed)).toBe(false)
    expect(distributeTranslationLikeSource(slots, translation)).toEqual(placed)
  })
})
