// AQU-1697: check pack A's findings on autopilot drafts.
//
// WHY: autopilot stores a finding as `bkp:<check>` plus its params; the
// reviewer must see the same check name as Rules → Built-in checks and the
// same explanation as the editor, or one finding reads as two different things.

import { describe, expect, it } from "vitest"
import { t } from "@/lib/i18n/standalone"
import { formatList, formatPercent } from "@/lib/i18n/format"
import { bibleFindingEvidence, bibleFindingLabel } from "./bible-findings"
import { findingFromCheck, findingsFromVerdicts } from "./draft-findings"
import { decodeBibleParams, encodeBibleParams } from "../../../db/shared/bible-checks/params"

const format = { list: (items: readonly string[]) => formatList(items, "en"), percent: (n: number) => formatPercent(n, "en") }

describe("autopilot labels for check pack A", () => {
  it("names each check as Rules → Built-in checks does", () => {
    const label = (detail: string) => bibleFindingLabel({ code: `bkp:${detail}`, kind: "bkp", detail }, t)
    expect(label("N1")).toBe("Bible data: Number kept")
    expect(label("M3")).toBe("Bible data: Negation kept")
    expect(label("S6")).toBe("Bible data: Verses the oldest manuscripts lack")
    expect(label("S8")).toBe("Bible data: Verse numbering")
  })

  it("explains a stored M3 finding with the editor's words and evidence", () => {
    const params = decodeBibleParams("kind=negation-missing&expected=1&found=0&evidence=negation&refs=JHN+4%3A9")
    expect(bibleFindingEvidence({ code: "bkp:M3", kind: "bkp", detail: "M3", params }, t, format)).toEqual([
      "The source makes a negative statement in this verse, but the translation has none of the negative words from the Language profile. Without one, the meaning can be the opposite.",
      "Macula: negation in JHN 4:9",
    ])
  })
})

// AQU-1701: the Jev-only questions, and C1's Translation Questions.
// WHY: a comprehension finding is only useful if the reviewer sees what the
// translation may not say and which question asked it; and "Check with Bible
// data" must word a finding exactly as a draft's, or one finding reads as two.
describe("the participant questions and C1", () => {
  const C1 = {
    kind: "answer-missing",
    evidence: "translation-question",
    tq: "tq:test-9-10",
    refs: "JHN 4:9,JHN 4:10",
    question: "What did Jesus offer?",
    answer: "Jesus offered her living water.",
    more: "2",
  }

  it("names each check", () => {
    const label = (detail: string) => bibleFindingLabel({ code: `bkp:${detail}`, kind: "bkp", detail }, t)
    expect(label("C1")).toBe("Bible data: Comprehension")
    expect(label("P13")).toBe("Bible data: Clear who is meant")
    expect(label("P11")).toBe("Bible data: Participant introduced")
  })

  it("explains a C1 finding: the answer the translation may not give, the question, its verses, and the rest", () => {
    const [finding] = findingsFromVerdicts({ "bkp:C1": encodeBibleParams(C1) }).findings
    expect(bibleFindingEvidence(finding, t, format)).toEqual([
      "Comprehension: the translation may not say that “Jesus offered her living water.”",
      "Translation Question (JHN 4:9, JHN 4:10): What did Jesus offer?",
      "2 more Translation Questions here may not be answered either",
    ])
  })

  it("words a 'Check with Bible data' finding exactly as a draft's", () => {
    const fromCheck = findingFromCheck({ code: "bkp:C1", params: C1 })
    const fromDraft = findingsFromVerdicts({ "bkp:C1": encodeBibleParams(C1) }).findings[0]
    if (!fromCheck) throw new Error("not a finding")
    expect(bibleFindingLabel(fromCheck, t)).toBe(bibleFindingLabel(fromDraft, t))
    expect(bibleFindingEvidence(fromCheck, t, format)).toEqual(bibleFindingEvidence(fromDraft, t, format))
  })
})
