// AQU-1658 — participant reference at a subject switch.
//
// Fixture: John 13:37–38. Peter speaks in v.37; in v.38 the Greek switches to
// Jesus (ἀποκρίνεται Ἰησοῦς), but a draft that says "He answered" leaves a
// reader who has just read Peter's words thinking Peter answers. Nothing in
// v.38 alone is wrong — "He answered" is a fine sentence — so the error only
// exists across the boundary, and only Jev's reading of BOTH sides finds it.

import { describe, expect, it } from "vitest"
import { IMPLIED, referenceBoundaries, referenceCheck } from "./reference"
import { harmonizerFindings, planHarmonizer } from "./runner"
import { wordSpans } from "./segment"
import type { HarmonizerCell } from "./types"

const JOHN_13: HarmonizerCell[] = [
  {
    id: "JHN 13:37", ref: "JHN 13:37",
    source: "λέγει αὐτῷ ὁ Πέτρος· κύριε, διὰ τί οὐ δύναμαί σοι ἀκολουθῆσαι ἄρτι;",
    target: "Peter said to him, “Lord, why can I not follow you now? I will lay down my life for you.”",
  },
  {
    id: "JHN 13:38", ref: "JHN 13:38",
    source: "ἀποκρίνεται Ἰησοῦς· τὴν ψυχήν σου ὑπὲρ ἐμοῦ θήσεις;",
    target: "He answered, “Will you lay down your life for me?”",
  },
]

const ask = (answers: Record<string, unknown>) =>
  referenceCheck.findings(referenceCheck.plan(JOHN_13)!, JOHN_13, answers, "p_")

describe("wordSpans — any script", () => {
  it("finds words without spaces (Thai) and skips punctuation", () => {
    const thai = wordSpans("เขาตอบว่า")
    expect(thai.length).toBeGreaterThan(1)
    expect(thai.map((w) => w.text).join("")).toBe("เขาตอบว่า")
    expect(wordSpans("He answered, “Will you…”").map((w) => w.text)).toEqual(["He", "answered", "Will", "you"])
  })
})

describe("referenceBoundaries", () => {
  it("skips a boundary into a validated cell — a person who knew the speaker already read it", () => {
    const validated = [JOHN_13[0], { ...JOHN_13[1], validated: true }]
    expect(referenceBoundaries(validated)).toEqual([])
  })

  it("skips undrafted cells", () => {
    expect(referenceBoundaries([JOHN_13[0], { ...JOHN_13[1], target: " " }])).toEqual([])
  })

  it("asks about the boundaries nearest the middle of the passage first, up to the cap", () => {
    // 9 cells: the active cell is index 4. Ties go to the earlier boundary.
    const cells = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, source: "σ", target: `t ${i}` }))
    expect(referenceBoundaries(cells, 3).map((x) => x.b)).toEqual([4, 3, 5])
  })
})

describe("referenceCheck findings", () => {
  it("flags 'He' in v.38: the source switches to Jesus, a reader would take Peter", () => {
    expect(ask({
      p_r0_switch: { noul: 0.93 },
      p_r0_clear: { noul: 0.12 },
      p_r0_word: { choice: "w0", probabilities: { w0: 0.88 } },
    })).toEqual([{
      checkId: "textual.reference",
      metafunction: "textual",
      cellId: "JHN 13:38",
      start: 0,
      end: 2,
      old: "He",
      new: "He",
      flagOnly: true,
      reasonKey: "harmonizer.reference.unclearSubject",
      reasonValues: { previous: "JHN 13:37" },
      confidence: 0.88,
    }])
  })

  it("says the subject is unstated when Jev finds no word for it, underlining the clause start", () => {
    const [f] = ask({
      p_r0_switch: { noul: 0.9 },
      p_r0_clear: { noul: 0.2 },
      p_r0_word: { choice: IMPLIED, probabilities: { [IMPLIED]: 0.7 } },
    })
    expect(f).toMatchObject({ reasonKey: "harmonizer.reference.impliedSubject", old: "He", start: 0 })
  })

  it("never flags a subject that does not switch, however the target reads", () => {
    expect(ask({ p_r0_switch: { noul: 0.3 }, p_r0_clear: { noul: 0.05 } })).toEqual([])
  })

  it("never flags a switch the target already makes clear", () => {
    expect(ask({ p_r0_switch: { noul: 0.95 }, p_r0_clear: { noul: 0.6 } })).toEqual([])
  })

  it("never flags on a missing answer", () => {
    expect(ask({ p_r0_switch: { noul: 0.95 } })).toEqual([])
  })
})

describe("runner with both checks", () => {
  it("keeps each check's questions and answers apart", () => {
    const run = planHarmonizer(JOHN_13, "m")
    const ids = Object.keys(run.request!.questions).filter((id) => id.startsWith("h1_"))
    expect(ids).toEqual(["h1_r0_switch", "h1_r0_clear", "h1_r0_word"])
    const findings = harmonizerFindings(run, JOHN_13, {
      answers: {
        h1_r0_switch: { noul: 0.93 },
        h1_r0_clear: { noul: 0.12 },
        h1_r0_word: { choice: "w0", probabilities: { w0: 0.88 } },
      },
    })
    expect(findings.map((f) => f.checkId)).toEqual(["textual.reference"])
  })
})
