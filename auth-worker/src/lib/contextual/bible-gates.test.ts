// AQU-1690: the bkp: gates on autopilot drafts.
//
// WHY: the same Bible data checks the editor runs must hold for autopilot's
// drafts, but a quotation-mark slip has a cheap fix of its own — it must not
// buy the ~55-unit deep panel the way a project-rule violation does. And a
// failure that survives its repair is a fact the draft contradicts: it goes
// to a person with its evidence, it is not hidden as advisory.

import { describe, expect, it } from "vitest"
import { lintSpanDraft } from "./lint-node"
import { classifyRisk } from "./router"
import { cellFindings } from "./findings"
import { fallbackTriage } from "./triage"
import { bibleConstraint, isRepairable, recheckForStage, withBibleVerdicts, type BibleGate } from "./bible-gates"
import { decodeBibleParams } from "../../../../db/shared/bible-checks/params"
import { ENGLISH_QUOTES, jhn4BibleData, jhn4Pairs } from "./bible-test-helpers"
import type { LintFlag, SpanDraft } from "./types"

/** JHN 4:9 with the quotation closed AFTER the narrator's aside — the classic slip. */
const ASIDE_INSIDE =
  "The Samaritan woman said to him, “How is it that you, a Jew, ask for a drink from me, a woman of Samaria? (For Jews have no dealings with Samaritans.)”"
const CORRECT_4_9 =
  "The Samaritan woman said to him, “How is it that you, a Jew, ask for a drink from me, a woman of Samaria?” (For Jews have no dealings with Samaritans.)"

function draftOf(cells: { cellId: string; text: string }[]): SpanDraft {
  return { spanId: "s1", sceneBriefId: "sb1", cells, exampleIds: [], promptVersion: "v" }
}

async function gate(): Promise<BibleGate> {
  const data = await jhn4BibleData()
  return { expectations: data.expectations, profile: data.profile }
}

describe("lintSpanDraft with Bible data", () => {
  it("flags JHN 4:9 when the woman's quotation closes after the narrator's aside", async () => {
    const flags = lintSpanDraft([], jhn4Pairs(), draftOf([{ cellId: "c9", text: ASIDE_INSIDE }]), [], await gate())
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ cellId: "c9", ruleId: "bkp:V2", message: "close-after-aside" })
    expect(flags[0].bible?.evidence).toMatchObject({ kind: "speech", startRef: "JHN 4:9" })
  })

  it("passes a draft that keeps the pack's quotation structure", async () => {
    expect(lintSpanDraft([], jhn4Pairs(), draftOf([{ cellId: "c9", text: CORRECT_4_9 }]), [], await gate())).toEqual([])
  })

  it("runs no Bible check without a gate (checks enrichment off)", () => {
    expect(lintSpanDraft([], jhn4Pairs(), draftOf([{ cellId: "c9", text: ASIDE_INSIDE }]))).toEqual([])
  })
})

describe("routing: Bible data flags are counted apart from lint", () => {
  const draft = draftOf([{ cellId: "c9", text: ASIDE_INSIDE }])
  const bkp: LintFlag = { spanId: "s1", cellId: "c9", ruleId: "bkp:V2", message: "close-after-aside" }
  const lint: LintFlag = { spanId: "s1", cellId: "c9", ruleId: "term-grace", message: "forbidden rendering" }

  it("a bkp: flag alone does not route to the deep panel", () => {
    const risk = classifyRisk(draft, [bkp], [], 1)
    expect(risk.level).toBe("low")
    expect(risk.verifiers).toEqual(["ambiguity"])
  })

  it("a lint flag still does", () => {
    const risk = classifyRisk(draft, [bkp, lint], [], 1)
    expect(risk.level).toBe("high")
    expect(risk.reasons).toContain("1 lint flag(s)")
    expect(risk.sourceFindingIds).toEqual(["term-grace"])
  })
})

describe("finding codes and triage", () => {
  it("records a Bible data flag under its own bkp: code, not as lint", () => {
    const flags: LintFlag[] = [{ spanId: "s1", cellId: "c9", ruleId: "bkp:V2", message: "close-after-aside" }]
    expect(cellFindings("c9", { votes: [], flags, redrafted: false, bible: ["bkp:V13"] })).toEqual(["bkp:V2", "bkp:V13"])
  })

  it("sends a warning to a person, and keeps an info finding advisory", () => {
    expect(fallbackTriage(["bkp:V2"])).toEqual({ triage: "human", severity: 3 })
    expect(fallbackTriage(["bkp:V13"])).toEqual({ triage: "human", severity: 3 })
    expect(fallbackTriage(["bkp:V7"])).toEqual({ triage: "advisory", severity: 2 })
  })
})

describe("stage re-check", () => {
  it("records what the FINAL text gets: a stale code goes, a residual warning goes to a person with its evidence", async () => {
    const g = await gate()
    const fixed = recheckForStage(g, "c9", CORRECT_4_9, ["bkp:V2", "redrafted"])
    expect(fixed).toEqual({ findings: ["redrafted"], values: {}, residual: false })

    const residual = recheckForStage(g, "c9", ASIDE_INSIDE, ["redrafted"])
    expect(residual.findings).toEqual(["redrafted", "bkp:V2"])
    expect(residual.residual).toBe(true)
    const verdicts = withBibleVerdicts({ "bkp:V2": "flag", redrafted: "flag", _triage: "advisory", _severity: "1" }, residual)
    expect(verdicts._triage).toBe("human")
    expect(verdicts._severity).toBe("3")
    expect(decodeBibleParams(verdicts["bkp:V2"])).toMatchObject({ kind: "close-after-aside", evidence: "speech", startRef: "JHN 4:9" })
  })

  it("keeps a code the evaluator cannot produce with this profile: it came from an active Jev question", async () => {
    const data = await jhn4BibleData({ profile: { quoteMarks: ENGLISH_QUOTES.quoteMarks } })
    const g = { expectations: data.expectations, profile: data.profile }
    // M1 is dormant without question markers, so a stored bkp:M1 was Jev's.
    expect(recheckForStage(g, "c9", CORRECT_4_9, ["bkp:M1"]).findings).toEqual(["bkp:M1"])
  })
})

describe("templated repair constraints", () => {
  it("names the speaker and the marks: 'close the woman's quotation before the aside'", async () => {
    const data = await jhn4BibleData()
    const [flag] = lintSpanDraft([], jhn4Pairs(), draftOf([{ cellId: "c9", text: ASIDE_INSIDE }]), [], {
      expectations: data.expectations,
      profile: data.profile,
    })
    if (!flag.bible) throw new Error("no finding")
    expect(bibleConstraint(flag.bible, data.facts.get("c9"), data.profile)).toBe(
      "Close Samaritan woman's quotation with ” before the words that follow it in this verse; they are not part of the quotation.",
    )
  })
})

// AQU-1697: check pack A rides the same gate. WHY: a dropped "not" reverses
// the verse, so M3 is a warning that autopilot repairs and, if it survives,
// sends to a person; but like a quotation slip it has a cheap fix of its own
// and must not buy the deep panel.
describe("a dropped negation (bkp:M3)", () => {
  const DROPPED_4_9 = CORRECT_4_9.replace("have no dealings", "have dealings")

  async function negationGate(): Promise<{ gate: BibleGate; data: Awaited<ReturnType<typeof jhn4BibleData>> }> {
    const data = await jhn4BibleData({ profile: { ...ENGLISH_QUOTES, negators: ["not", "no", "never"] } })
    return { gate: { expectations: data.expectations, profile: data.profile }, data }
  }

  it("flows through the gate as a repairable warning, apart from lint", async () => {
    const { gate, data } = await negationGate()
    const flags = lintSpanDraft([], jhn4Pairs(), draftOf([{ cellId: "c9", text: DROPPED_4_9 }]), [], gate)
    expect(flags).toEqual([expect.objectContaining({ cellId: "c9", ruleId: "bkp:M3", message: "negation-missing" })])
    const finding = flags[0].bible
    if (!finding) throw new Error("no finding")
    expect(finding.severity).toBe("warning")
    expect(isRepairable(finding)).toBe(true)
    expect(bibleConstraint(finding, data.facts.get("c9"), data.profile)).toBe(
      'Keep the negation: the source says "not" here, and without it the meaning is reversed.',
    )
    expect(lintSpanDraft([], jhn4Pairs(), draftOf([{ cellId: "c9", text: CORRECT_4_9 }]), [], gate)).toEqual([])
  })

  it("does not force the deep panel, and a surviving one goes to a person", async () => {
    const { gate } = await negationGate()
    const flags = lintSpanDraft([], jhn4Pairs(), draftOf([{ cellId: "c9", text: DROPPED_4_9 }]), [], gate)
    const risk = classifyRisk(draftOf([{ cellId: "c9", text: DROPPED_4_9 }]), flags, [], 1)
    expect(risk.level).toBe("low")
    expect(risk.verifiers).toEqual(["ambiguity"])
    expect(fallbackTriage(["bkp:M3"])).toEqual({ triage: "human", severity: 3 })
    expect(recheckForStage(gate, "c9", DROPPED_4_9, []).residual).toBe(true)
  })
})
