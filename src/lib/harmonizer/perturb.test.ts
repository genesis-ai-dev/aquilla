// AQU-1675 — the eval's damage must be exactly the error each check targets,
// and must refuse verses that are not a fair test. A perturbation that fires
// where the check cannot see the error would score the check as blind when the
// test was unfair. Fixtures are real BSB verses (public domain).

import { describe, expect, it } from "vitest"
import {
  perturbQuoteClose,
  perturbReferenceSwitch,
  perturbSentenceBrokenOff,
  perturbSentenceRunOn,
} from "./perturb"
import type { HarmonizerCell } from "./types"

const cell = (id: string, target: string, source = "σ."): HarmonizerCell => ({ id, ref: id, source, target })

describe("perturbQuoteClose", () => {
  it("drops the ” that closes a speech opened in an earlier verse (JHN 6:27)", () => {
    const cells = [
      cell("JHN 6:26", "Jesus replied, “Truly, truly, I tell you, it is not because you saw these signs that you are looking for Me, but because you ate the loaves and had your fill."),
      cell("JHN 6:27", "Do not work for food that perishes… For on Him God the Father has placed His seal of approval.”"),
    ]
    const p = perturbQuoteClose(cells, 1)!
    expect(p.cells[1].target.endsWith("approval.")).toBe(true)
    expect(p.expectCheck).toBe("textual.quotation")
  })

  it("refuses a speech that opened before the passage — the check cannot see it open", () => {
    const cells = [
      cell("JHN 6:27", "Do not work for food that perishes… For on Him God the Father has placed His seal of approval.”"),
    ]
    expect(perturbQuoteClose(cells, 0)).toBeNull()
  })

  it("refuses a speech that opens and closes in the same verse — nothing cross-cell to find", () => {
    expect(perturbQuoteClose([cell("JHN 6:28", "Then they inquired, “What must we do?”")], 0)).toBeNull()
  })
})

describe("perturbReferenceSwitch", () => {
  it("JHN 13:38: “Jesus replied” → “he replied” after a verse where Peter speaks", () => {
    const cells = [
      cell("JHN 13:37", "“Lord,” said Peter, “why can’t I follow You now? I will lay down my life for You.”"),
      cell("JHN 13:38", "“Will you lay down your life for Me?” Jesus replied. “Truly, truly, I tell you…"),
    ]
    const p = perturbReferenceSwitch(cells, 1)!
    expect(p.cells[1].target).toBe("“Will you lay down your life for Me?” he replied. “Truly, truly, I tell you…")
  })

  it("capitalises the pronoun at the start of a verse", () => {
    const cells = [cell("a", "Peter said, “Lord.”"), cell("b", "Jesus replied, “Truly.”")]
    expect(perturbReferenceSwitch(cells, 1)!.cells[1].target).toBe("He replied, “Truly.”")
  })

  it("refuses when the same participant continues — not a switch", () => {
    const cells = [cell("a", "Jesus went up the mountain."), cell("b", "Jesus said, “Come.”")]
    expect(perturbReferenceSwitch(cells, 1)).toBeNull()
  })
})

describe("perturbSentenceBrokenOff", () => {
  it("refuses a split that leaves a complete sentence — the check rightly stays quiet there", () => {
    const cells = [cell("a", "Hezekiah was the father of Manasseh, Amon the father of Josiah,"), cell("b", "and Josiah the father of Jeconiah.")]
    expect(perturbSentenceBrokenOff(cells, 0)).toBeNull()
  })

  it("turns a running sentence's verse-final comma into a stop and capitalises the next verse", () => {
    const cells = [cell("a", "When they had crossed over,"), cell("b", "they landed at Gennesaret.")]
    const p = perturbSentenceBrokenOff(cells, 0)!
    expect(p.cells.map((c) => c.target)).toEqual(["When they had crossed over.", "They landed at Gennesaret."])
  })

  it("refuses when the next verse already starts a new sentence", () => {
    expect(perturbSentenceBrokenOff([cell("a", "And so,"), cell("b", "Then he went.")], 0)).toBeNull()
  })
})

describe("perturbSentenceRunOn", () => {
  it("drops a full stop where the source sentence also ends", () => {
    const cells = [cell("a", "In the beginning was the Word.", "Ἐν ἀρχῇ ἦν ὁ λόγος."), cell("b", "He was with God.")]
    expect(perturbSentenceRunOn(cells, 0)!.cells[0].target).toBe("In the beginning was the Word")
  })

  it("refuses when the source sentence runs on (Greek ano teleia ·)", () => {
    const cells = [cell("a", "He said.", "εἶπεν·"), cell("b", "Come here.")]
    expect(perturbSentenceRunOn(cells, 0)).toBeNull()
  })
})
