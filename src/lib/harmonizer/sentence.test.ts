// AQU-1659 — sentence continuity at a seam.
//
// Fixture: Luke 5:4, the case seams were built for. The Greek sentence runs
// across the verse boundary ("ὡς δὲ ἐπαύσατο λαλῶν, εἶπεν | πρὸς τὸν Σίμωνα·").
// Drafted cell by cell, v.4a can come out as "When he had finished speaking,
// he said." — a full stop that cuts the sentence in half.
//
// Splitting a long source sentence into several target sentences is often
// the RIGHT call, so these tests also pin what must NOT be flagged.

import { describe, expect, it } from "vitest"
import {
  endsBare,
  endsSentence,
  learnTerminator,
  sentenceBoundaries,
  sentenceCheck,
  startsLowercase,
} from "./sentence"
import type { HarmonizerCell } from "./types"

const LUKE_5: HarmonizerCell[] = [
  { id: "LUK 5:4a", ref: "LUK 5:4a", source: "ὡς δὲ ἐπαύσατο λαλῶν, εἶπεν", target: "When he had finished speaking, he said." },
  { id: "LUK 5:4b", ref: "LUK 5:4b", source: "πρὸς τὸν Σίμωνα· ἐπανάγαγε εἰς τὸ βάθος.", target: "To Simon, “Put out into the deep.”" },
]

const findingsFor = (cells: HarmonizerCell[], answers: Record<string, unknown>) =>
  sentenceCheck.findings(sentenceCheck.plan(cells)!, cells, answers, "p_")

describe("target-side tests, any script", () => {
  it("knows a sentence end through closing quotes, and that an ellipsis trails off", () => {
    expect(endsSentence("“Put out into the deep.”")).toBe(true)
    expect(endsSentence("ये बातें कहीं।")).toBe(true)
    expect(endsSentence("and then…")).toBe(false)
    expect(endsSentence("He said:")).toBe(false)
  })

  it("reads case only in scripts that have it", () => {
    expect(startsLowercase("“to Simon")).toBe(true)
    expect(startsLowercase("To Simon")).toBe(false)
    expect(startsLowercase("เขาตอบ")).toBe(false)
    expect(endsBare("he said")).toBe(true)
    expect(endsBare("he said,")).toBe(false)
  })

  it("learns the project's own terminator, validated cells first", () => {
    const cells: HarmonizerCell[] = [
      { id: "a", source: "", target: "यीशु ने कहा।", validated: true },
      { id: "b", source: "", target: "draft one." },
      { id: "c", source: "", target: "draft two." },
    ]
    expect(learnTerminator(cells)).toBe("।")
    expect(learnTerminator([{ id: "a", source: "", target: "no stop" }])).toBeNull()
  })
})

describe("sentenceBoundaries", () => {
  it("sorts each join by what the target shows", () => {
    const cells: HarmonizerCell[] = [
      { id: "0", source: "s", target: "One." },
      { id: "1", source: "s", target: "two continues" },
      { id: "2", source: "s", target: "Three." },
    ]
    expect(sentenceBoundaries(cells)).toEqual([
      { b: 1, kind: "brokenCase" },
      { b: 2, kind: "runOn" },
    ])
  })

  it("leaves a join alone when both cells are validated", () => {
    expect(sentenceBoundaries(LUKE_5.map((c) => ({ ...c, validated: true })))).toEqual([])
  })
})

describe("sentenceCheck findings", () => {
  it("broken case needs no model: a full stop followed by lowercase contradicts itself", () => {
    const cells = [LUKE_5[0], { ...LUKE_5[1], target: "to Simon, “Put out into the deep.”" }]
    const plan = sentenceCheck.plan(cells)!
    expect(sentenceCheck.questions(plan, "p_")).toEqual({})
    expect(findingsFor(cells, {})).toEqual([expect.objectContaining({
      cellId: "LUK 5:4a", old: "said.", new: "said.", flagOnly: true,
      reasonKey: "harmonizer.sentence.brokenCase", reasonValues: { next: "LUK 5:4b" },
    })])
  })

  it("Luke 5:4: flags the full stop that cuts the source's sentence in half", () => {
    expect(findingsFor(LUKE_5, {
      p_t0_continues: { noul: 0.95 },
      p_t0_complete: { noul: 0.1 },
    })).toEqual([expect.objectContaining({
      cellId: "LUK 5:4a", old: "said.", flagOnly: true, reasonKey: "harmonizer.sentence.brokenOff",
    })])
  })

  it("flags a fragment closed by a full stop even when the source only weakly runs on (ACT 3:9)", () => {
    // Greek often closes a clause where English needs the next verse, so Jev's
    // source answer sat at 0.52 on this real fragment in the eval.
    const cells = [
      { id: "ACT 3:9", ref: "ACT 3:9", source: "καὶ εἶδεν πᾶς ὁ λαὸς αὐτὸν περιπατοῦντα καὶ αἰνοῦντα τὸν θεόν,", target: "When all the people saw him walking and praising God." },
      { id: "ACT 3:10", ref: "ACT 3:10", source: "ἐπεγίνωσκον δὲ αὐτὸν…", target: "They recognized him as the man who used to sit begging." },
    ]
    expect(findingsFor(cells, { p_t0_continues: { noul: 0.52 }, p_t0_complete: { noul: 0.19 } }))
      .toEqual([expect.objectContaining({ cellId: "ACT 3:9", reasonKey: "harmonizer.sentence.brokenOff" })])
  })

  it("leaves a verbless heading alone: the source does not run on either", () => {
    const cells = [
      { id: "MRK 1:1", ref: "MRK 1:1", source: "Ἀρχὴ τοῦ εὐαγγελίου Ἰησοῦ Χριστοῦ υἱοῦ θεοῦ.", target: "The beginning of the gospel of Jesus Christ, the Son of God." },
      { id: "MRK 1:2", ref: "MRK 1:2", source: "Καθὼς γέγραπται…", target: "As it is written in Isaiah the prophet…" },
    ]
    expect(findingsFor(cells, { p_t0_continues: { noul: 0.15 }, p_t0_complete: { noul: 0.2 } })).toEqual([])
  })

  it("does not flag a translator's deliberate split: the target sentence is complete", () => {
    const split = [{ ...LUKE_5[0], target: "When he had finished speaking, he turned to Simon." }, LUKE_5[1]]
    expect(findingsFor(split, { p_t0_continues: { noul: 0.95 }, p_t0_complete: { noul: 0.9 } })).toEqual([])
  })

  it("adds the project's terminator where the source sentence ends and the target runs on", () => {
    const cells: HarmonizerCell[] = [
      { id: "v1", ref: "v1", source: "ἐν ἀρχῇ ἦν ὁ λόγος.", target: "In the beginning was the Word" },
      { id: "v2", ref: "v2", source: "οὗτος ἦν ἐν ἀρχῇ πρὸς τὸν θεόν.", target: "He was in the beginning with God." },
    ]
    expect(findingsFor(cells, {
      p_t0_continues: { noul: 0.05 },
      p_t0_targetContinues: { noul: 0.1 },
    })).toEqual([expect.objectContaining({
      cellId: "v1", old: "Word", new: "Word.", reasonKey: "harmonizer.sentence.runOn",
    })])
    expect(findingsFor(cells, {
      p_t0_continues: { noul: 0.05 },
      p_t0_targetContinues: { noul: 0.8 },
    })).toEqual([])
  })

  it("never guesses on a missing answer", () => {
    expect(findingsFor(LUKE_5, { p_t0_continues: { noul: 0.95 } })).toEqual([])
  })
})
