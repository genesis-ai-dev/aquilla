/**
 * Project wordlist + spelling suspicion (AQU-1737).
 *
 * WHY these cases: the check's whole value is that it stays quiet. A spell
 * check with no dictionary that flags the project's own vocabulary gets
 * switched off in an afternoon, so most of what is pinned here is what must
 * NOT be flagged — source-carried names, frequent forms, case-only variants,
 * two-letter words — alongside the one thing that must be: a one-off variant
 * of a form the project writes often, carrying that form as the suggestion.
 */

import { describe, it, expect } from "vitest"
import {
  approveSpelling,
  autoApprovedSpellings,
  buildWordlist,
  DEFAULT_APPROVE_AT_OCCURRENCES,
  editDistanceAtMost,
  findSimilarWordGroups,
  findSuspectedMisspellings,
  maxDistanceFor,
  soundAlikeKey,
  withoutApprovedSpellings,
  wordsIn,
  type SpellableCell,
} from "./spelling"

const cell = (id: string, translated: string, cellLabel?: string): SpellableCell => ({
  id,
  cellLabel,
  translated,
})

/** A corpus that writes "Yesu" often and "Yeesu" exactly once. */
function yesuCorpus(): SpellableCell[] {
  return [
    cell("c1", "Yesu akasema", "MRK 1:1"),
    cell("c2", "Yesu alijibu", "MRK 1:2"),
    cell("c3", "Yesu akaenda", "MRK 1:3"),
    cell("c4", "Yesu akawaita", "MRK 1:4"),
    cell("c5", "Yeesu akasema tena", "MRK 1:5"),
  ]
}

describe("wordsIn", () => {
  it("takes letters, marks, apostrophes and hyphens as one word", () => {
    expect(wordsIn("mwana-mfalme n'go José")).toEqual(["mwana-mfalme", "n'go", "José"])
  })
  it("trims apostrophes and hyphens off the edges", () => {
    expect(wordsIn("—'ndiyo'—")).toEqual(["ndiyo"])
  })
  it("skips USFM markers, which are markup and not words", () => {
    expect(wordsIn("\\p Yesu \\zaln-s akasema")).toEqual(["Yesu", "akasema"])
  })
  it("ignores digits and punctuation", () => {
    expect(wordsIn("sura 3, mstari 16!")).toEqual(["sura", "mstari"])
  })
})

describe("buildWordlist", () => {
  it("counts every occurrence and records the cells a form occurs in", () => {
    const list = buildWordlist(yesuCorpus())
    const yesu = list.find((e) => e.form === "Yesu")
    expect(yesu?.occurrences).toBe(4)
    expect(yesu?.cells.map((c) => c.cellId)).toEqual(["c1", "c2", "c3", "c4"])
    expect(yesu?.firstSeenCellId).toBe("c1")
    expect(yesu?.cells[0]?.cellLabel).toBe("MRK 1:1")
  })
  it("counts repeats inside one cell but lists that cell once", () => {
    const list = buildWordlist([cell("c1", "Yesu Yesu Yesu")])
    expect(list[0]).toMatchObject({ form: "Yesu", occurrences: 3 })
    expect(list[0]?.cells).toHaveLength(1)
  })
  it("keeps case, so a reviewer can see which spelling the project writes", () => {
    // Two entries, not one folded entry. (Their order is locale collation's
    // business, so the assertion is on membership.)
    const forms = buildWordlist([cell("c1", "Yesu yesu")]).map((e) => e.form)
    expect(forms).toHaveLength(2)
    expect(new Set(forms)).toEqual(new Set(["Yesu", "yesu"]))
  })
  it("sorts most frequent first, then alphabetically", () => {
    const list = buildWordlist([cell("c1", "beta alfa alfa gamma")])
    expect(list.map((e) => e.form)).toEqual(["alfa", "beta", "gamma"])
  })
  it("ignores cells with no target text", () => {
    expect(buildWordlist([cell("c1", "   ")])).toEqual([])
  })
})

describe("soundAlikeKey", () => {
  it("folds a doubled vowel onto its single form", () => {
    expect(soundAlikeKey("Yeesu")).toBe(soundAlikeKey("Yesu"))
  })
  it("folds the s / sh / z class together", () => {
    expect(soundAlikeKey("mashua")).toBe(soundAlikeKey("masua"))
    expect(soundAlikeKey("zuri")).toBe(soundAlikeKey("suri"))
  })
  it("ignores case and combining marks", () => {
    expect(soundAlikeKey("José")).toBe(soundAlikeKey("jose"))
  })
  it("keeps genuinely different words apart", () => {
    expect(soundAlikeKey("mama")).not.toBe(soundAlikeKey("baba"))
  })
  it("applies only the script-neutral fold to a non-Latin script", () => {
    // The consonant classes are claims about Latin orthography; applying them
    // to Arabic would be invention. Case and repeats still fold.
    expect(soundAlikeKey("يسوع")).toBe("يسوع")
    expect(soundAlikeKey("يسووع")).toBe("يسوع")
  })
})

describe("editDistanceAtMost", () => {
  it("measures small edits exactly", () => {
    expect(editDistanceAtMost("Yesu", "Yeesu", 2)).toBe(1)
    expect(editDistanceAtMost("mama", "mama", 1)).toBe(0)
  })
  it("abandons past the bound instead of computing a useless number", () => {
    expect(editDistanceAtMost("mama", "shangazi", 1)).toBe(2)
  })
  it("allows two edits only once a form is long enough to afford them", () => {
    expect(maxDistanceFor("Yesu")).toBe(1)
    expect(maxDistanceFor("Wafilipi")).toBe(2)
  })
})

describe("findSuspectedMisspellings", () => {
  it("flags a one-off variant of a frequent form, suggesting that form (AQU-1737)", () => {
    const findings = findSuspectedMisspellings(buildWordlist(yesuCorpus()), {
      minCommonOccurrences: 3,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      form: "Yeesu",
      occurrences: 1,
      suggestion: "Yesu",
      suggestionOccurrences: 4,
      reason: "sound-alike",
    })
  })
  it("carries every cell the suspected form occurs in, so one decision covers them all", () => {
    const corpus = [...yesuCorpus(), cell("c6", "Yeesu alijibu", "MRK 1:6")]
    const findings = findSuspectedMisspellings(buildWordlist(corpus), {
      minCommonOccurrences: 3,
      maxSuspectOccurrences: 2,
    })
    expect(findings[0]?.cells.map((c) => c.cellId)).toEqual(["c5", "c6"])
  })
  it("does not flag a form the project writes often", () => {
    const findings = findSuspectedMisspellings(buildWordlist(yesuCorpus()), {
      minCommonOccurrences: 3,
    })
    expect(findings.map((f) => f.form)).not.toContain("Yesu")
  })
  it("does not flag a rare form with no frequent neighbour", () => {
    const findings = findSuspectedMisspellings(
      buildWordlist([cell("c1", "Yesu Yesu Yesu shangazi")]),
      { minCommonOccurrences: 3 },
    )
    expect(findings).toEqual([])
  })
  it("does not report a case-only variant — that is the capitalization check's finding", () => {
    const findings = findSuspectedMisspellings(
      buildWordlist([cell("c1", "Yesu Yesu Yesu yesu")]),
      { minCommonOccurrences: 3 },
    )
    expect(findings).toEqual([])
  })
  it("never flags a form the source text already writes that way", () => {
    const corpus = [...yesuCorpus()]
    const findings = findSuspectedMisspellings(buildWordlist(corpus), {
      minCommonOccurrences: 3,
      sourceForms: new Set(["Yeesu"]),
    })
    expect(findings).toEqual([])
  })
  it("leaves two-letter forms alone, where one edit means nothing", () => {
    const findings = findSuspectedMisspellings(
      buildWordlist([cell("c1", "na na na ni")]),
      { minCommonOccurrences: 3 },
    )
    expect(findings).toEqual([])
  })
  it("never suggests a form written no more often than the suspected one", () => {
    const findings = findSuspectedMisspellings(
      buildWordlist([cell("c1", "alfa alfb")]),
      { minCommonOccurrences: 1 },
    )
    expect(findings).toEqual([])
  })
  it("treats a form at the approval threshold as correct without review", () => {
    const common = Array.from({ length: 100 }, (_, i) => cell(`y${i}`, "Yesu"))
    const list = buildWordlist(common)
    expect(autoApprovedSpellings(list)).toEqual([{ form: "Yesu", occurrences: 100 }])
    expect(DEFAULT_APPROVE_AT_OCCURRENCES).toBe(100)
    expect(findSuspectedMisspellings(list).map((f) => f.form)).not.toContain("Yesu")
  })
  it("ranks the most-confident finding first", () => {
    const corpus = [
      cell("c1", "Yesu Yesu Yesu Yesu Yesu Yesu"),
      cell("c2", "mama mama mama"),
      cell("c3", "Yeesu mamma"),
    ]
    const findings = findSuspectedMisspellings(buildWordlist(corpus), { minCommonOccurrences: 3 })
    expect(findings.map((f) => f.form)).toEqual(["Yeesu", "mamma"])
  })
  it("reports a near-match when the forms do not sound alike", () => {
    const corpus = [cell("c1", "sura sura sura"), cell("c2", "surb")]
    const findings = findSuspectedMisspellings(buildWordlist(corpus), { minCommonOccurrences: 3 })
    expect(findings[0]).toMatchObject({ form: "surb", suggestion: "sura", reason: "near-match" })
  })
})

describe("approving a spelling clears every occurrence at once (AQU-1737)", () => {
  it("drops the whole finding, not one cell of it", () => {
    const corpus = [...yesuCorpus(), cell("c6", "Yeesu alijibu")]
    const findings = findSuspectedMisspellings(buildWordlist(corpus), {
      minCommonOccurrences: 3,
      maxSuspectOccurrences: 2,
    })
    expect(findings[0]?.cells).toHaveLength(2)

    const approved = approveSpelling(new Set<string>(), "Yeesu")
    expect(withoutApprovedSpellings(findings, approved)).toEqual([])
  })
  it("stays cleared when the check runs again", () => {
    const approved = approveSpelling(new Set<string>(), "Yeesu")
    const findings = findSuspectedMisspellings(buildWordlist(yesuCorpus()), {
      minCommonOccurrences: 3,
      approved,
    })
    expect(findings).toEqual([])
  })
  it("leaves other forms flagged", () => {
    const corpus = [
      cell("c1", "Yesu Yesu Yesu"),
      cell("c2", "mama mama mama"),
      cell("c3", "Yeesu mamma"),
    ]
    const findings = findSuspectedMisspellings(buildWordlist(corpus), { minCommonOccurrences: 3 })
    const left = withoutApprovedSpellings(findings, approveSpelling(new Set<string>(), "Yeesu"))
    expect(left.map((f) => f.form)).toEqual(["mamma"])
  })
})

describe("findSimilarWordGroups (Paratext's Find Similar Words)", () => {
  it("groups the spellings of one word together, most frequent first", () => {
    const groups = findSimilarWordGroups(buildWordlist(yesuCorpus()))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.forms.map((f) => f.form)).toEqual(["Yesu", "Yeesu"])
  })
  it("does not make a group out of one form written one way", () => {
    expect(findSimilarWordGroups(buildWordlist([cell("c1", "Yesu Yesu")]))).toEqual([])
  })
  it("does not make a group out of a case-only difference", () => {
    expect(findSimilarWordGroups(buildWordlist([cell("c1", "Yesu yesu")]))).toEqual([])
  })
  it("puts the biggest spelling split first", () => {
    const corpus = [
      cell("c1", "mashua masua mazua"),
      cell("c2", "Yesu Yeesu"),
    ]
    const groups = findSimilarWordGroups(buildWordlist(corpus))
    expect(groups[0]?.forms).toHaveLength(3)
  })
})
