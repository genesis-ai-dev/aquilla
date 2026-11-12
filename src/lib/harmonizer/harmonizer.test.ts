// AQU-1657 — the quotation-continuity check and the runner around it.
//
// The fixture is the case that motivated it: John 6:26–28 drafted from Greek.
// Jesus's reply opens in v.26 and runs to the end of v.27, but the draft of
// v.27 never closes it, and v.28 opens the crowd's question. Greek has no
// quotation marks, so nothing in any one cell is wrong — the error only exists
// across cells.

import { describe, expect, it } from "vitest"
import {
  closingSpan,
  findQuoteSpans,
  learnQuotePair,
  quotationCheck,
} from "./quotes"
import { harmonizerFindings, planHarmonizer } from "./runner"
import type { HarmonizerCell, HarmonyCheck } from "./types"

const JOHN_6: HarmonizerCell[] = [
  {
    id: "JHN 6:26", ref: "JHN 6:26",
    source: "ἀπεκρίθη αὐτοῖς ὁ Ἰησοῦς καὶ εἶπεν· ἀμὴν ἀμὴν λέγω ὑμῖν, ζητεῖτέ με οὐχ ὅτι εἴδετε σημεῖα…",
    target: "Jesus answered them, “Truly, truly, I say to you, you seek me not because you saw signs…",
  },
  {
    id: "JHN 6:27", ref: "JHN 6:27",
    source: "ἐργάζεσθε μὴ τὴν βρῶσιν τὴν ἀπολλυμένην… τοῦτον γὰρ ὁ πατὴρ ἐσφράγισεν ὁ θεός.",
    target: "Do not work for the food that perishes… For on him God the Father has set his seal.",
  },
  {
    id: "JHN 6:28", ref: "JHN 6:28",
    source: "εἶπον οὖν πρὸς αὐτόν· τί ποιῶμεν ἵνα ἐργαζώμεθα τὰ ἔργα τοῦ θεοῦ;",
    target: "Then they said to him, “What must we do, to be doing the works of God?”",
  },
]
const CURLY = { open: "“", close: "”" }

/** A Jev response for the quotation check's questions, keyed as the runner asks them. */
function jev(answers: Record<string, unknown>) {
  return { answers }
}

describe("learnQuotePair — the project's own realisation", () => {
  it("prefers the pair the validated cells use over what drafts use", () => {
    const cells: HarmonizerCell[] = [
      { id: "a", source: "", target: "Il dit : « Venez. »", validated: true },
      { id: "b", source: "", target: "He said, “Come.”" },
      { id: "c", source: "", target: "She said, “Go.”" },
    ]
    expect(learnQuotePair(cells)).toEqual({ open: "«", close: "»" })
  })

  it("is not fooled by apostrophes into picking single quotes", () => {
    const cells: HarmonizerCell[] = [
      { id: "a", source: "", target: "He said, “Don’t be afraid; it’s I.” They didn’t know." },
    ]
    expect(learnQuotePair(cells)).toEqual(CURLY)
  })

  it("returns null when the project has quoted nothing yet — no realisation to match", () => {
    expect(learnQuotePair([{ id: "a", source: "", target: "No quotes here." }])).toBeNull()
  })
})

describe("findQuoteSpans", () => {
  it("John 6: a quotation opened in v.26 and re-opened in v.28 broke somewhere in v.26–27", () => {
    expect(findQuoteSpans(JOHN_6, CURLY)).toEqual([{ startCell: 0, candidates: [0, 1], broken: true }])
  })

  it("a correctly closed passage needs no questions", () => {
    const fixed = JOHN_6.map((c, i) => (i === 1 ? { ...c, target: c.target + "”" } : c))
    expect(findQuoteSpans(fixed, CURLY)).toEqual([])
    expect(quotationCheck.plan(fixed)).toBeNull()
  })

  it("re-opening at the start of a cell is the continued-paragraph convention, not a break", () => {
    const cells: HarmonizerCell[] = [
      { id: "a", source: "", target: "He said, “The first part," },
      { id: "b", source: "", target: "“and the second part.”" },
    ]
    expect(findQuoteSpans(cells, CURLY)).toEqual([])
  })

  it("a quotation still open at the end of the passage is seen but NOT asked about", () => {
    // Long discourses (John 8, John 14) run past the window; asking where they
    // end produced most false alarms on clean text in the eval. Only a broken
    // quotation — a new one opened — proves the speech ended.
    const open = JOHN_6.slice(0, 2)
    expect(findQuoteSpans(open, CURLY)).toEqual([{ startCell: 0, candidates: [0, 1], broken: false }])
    expect(quotationCheck.plan(open)).toBeNull()
  })
})

describe("closingSpan", () => {
  it("underlines the last word with its punctuation, ignoring trailing space", () => {
    const text = "has set his seal.  "
    const r = closingSpan(text)!
    expect(text.slice(r.start, r.end)).toBe("seal.")
  })
})

describe("planHarmonizer + harmonizerFindings — end to end on John 6", () => {
  const run = planHarmonizer(JOHN_6, "typesafe/jev-1.13")

  it("asks one batched request, every question id namespaced by its check", () => {
    expect(run.request).not.toBeNull()
    const ids = Object.keys(run.request!.questions).filter((id) => id.startsWith("h0_"))
    expect(ids).toEqual(["h0_s0", "h0_s0_end0", "h0_s0_end1"])
    expect(run.request!.state.cells[1]).toMatchObject({ index: 1, ref: "JHN 6:27" })
  })

  it("closes the quotation at the end of v.27 when Jev places the end of the speech there", () => {
    const findings = harmonizerFindings(run, JOHN_6, jev({
      h0_s0: { choice: "c1", probabilities: { c0: 0.05, c1: 0.95 } },
      h0_s0_end0: { noul: 0.1 },
      h0_s0_end1: { noul: 0.9 },
    }))
    expect(findings).toEqual([{
      checkId: "textual.quotation",
      metafunction: "textual",
      cellId: "JHN 6:27",
      start: JOHN_6[1].target.lastIndexOf("seal."),
      end: JOHN_6[1].target.length,
      old: "seal.",
      new: "seal.”",
      reasonKey: "harmonizer.quotes.closeHere",
      reasonValues: { openedIn: "JHN 6:26" },
      confidence: 0.9,
    }])
  })

  it("suggests nothing when Jev is unsure which verse the speech ends in", () => {
    expect(harmonizerFindings(run, JOHN_6, jev({
      h0_s0: { choice: "c1", probabilities: { c0: 0.45, c1: 0.55 } },
      h0_s0_end1: { noul: 0.9 },
    }))).toEqual([])
  })

  it("suggests nothing when the speech ends mid-verse — placing the mark there is not a rule's job", () => {
    expect(harmonizerFindings(run, JOHN_6, jev({
      h0_s0: { choice: "c1", probabilities: { c1: 0.95 } },
      h0_s0_end1: { noul: 0.2 },
    }))).toEqual([])
  })

  it("suggests nothing from a missing or malformed response", () => {
    expect(harmonizerFindings(run, JOHN_6, null)).toEqual([])
    expect(harmonizerFindings(run, JOHN_6, jev({ h0_s0: "c1" }))).toEqual([])
  })

  it("asks nothing at all for a passage with no quotation problems", () => {
    const fixed = JOHN_6.map((c, i) => (i === 1 ? { ...c, target: c.target + "”" } : c))
    expect(planHarmonizer(fixed, "m", [quotationCheck as HarmonyCheck<unknown>]).request).toBeNull()
  })
})
