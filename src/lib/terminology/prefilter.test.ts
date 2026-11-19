// AQU-2654: the acceptance gate for the terminology candidate prefilter.
//
// The prefilter decides which concepts get their regex compiled and run. It is
// allowed to pass a concept that does not match; it is never allowed to turn
// away one that does — a miss is a highlight, a lookup or an infraction that
// silently stops appearing. Every test here compares against the regex itself.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildConceptRegex,
  candidateConcepts,
  compiledPatternCount,
  conceptPrefilter,
  findConceptMatches,
  findPlainTermMatches,
  buildTermRegex,
  matchesConcept,
} from "./match"
import {
  AnchorIndex,
  foldForPrefilter,
  mayMatch,
  prefilterForTerms,
  setPrefilterMode,
  termAnchor,
  verifyRejected,
} from "./prefilter"
import type { ConceptMatchInput, TermMatchingSettings } from "./model"
import { compileConceptsToRules } from "./compile"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "./types"
import { TERMINOLOGY_LINT_PARITY_CASES } from "./__fixtures__/terminology-lint-parity"

// The suite runs in `verify` (src/test-setup.ts). These tests drive the mode
// themselves and put it back.
beforeEach(() => setPrefilterMode("on"))
afterEach(() => setPrefilterMode("verify"))

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The matcher with no prefilter and no cache: a fresh regex, run directly. */
function referenceMatches(
  text: string,
  concept: ConceptMatchInput,
  project?: TermMatchingSettings,
): Array<{ start: number; end: number; surface: string }> {
  const re = buildConceptRegex(concept, project, concept.caseSensitive ? "gu" : "giu")
  if (!re || !text) return []
  const out: Array<{ start: number; end: number; surface: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1
      continue
    }
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0] })
  }
  return out
}

function referenceTest(text: string, concept: ConceptMatchInput, project?: TermMatchingSettings): boolean {
  if (!text) return false
  const re = buildConceptRegex(concept, project, concept.caseSensitive ? "u" : "iu")
  return re !== null && re.test(text)
}

describe("the fold agrees with the regex engine, code point by code point", () => {
  // Every code point that takes part in case mapping at all.
  const cased: string[] = []
  const others: string[] = []
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const ch = String.fromCodePoint(cp)
    if (
      /[\p{Cased}\p{Changes_When_Casefolded}\p{Changes_When_Lowercased}\p{Changes_When_Uppercased}\p{Changes_When_Titlecased}ͅ]/u.test(ch)
    ) {
      cased.push(ch)
    } else {
      others.push(ch)
    }
  }

  it("two code points a case-insensitive literal treats as equal fold to the same string", () => {
    // One line per cased code point; each code point is then run over all of
    // them as an anchored, case-insensitive, multiline literal. ~4,500 x 4,500
    // pairs, decided by the engine the app runs on.
    const haystack = cased.join("\n")
    let pairs = 0
    const disagreements: string[] = []
    for (const c of cased) {
      const re = new RegExp(`^${escapeRegex(c)}$`, "gimu")
      for (const m of haystack.matchAll(re)) {
        const d = m[0]
        if (d === c) continue
        pairs += 1
        if (foldForPrefilter(c) !== foldForPrefilter(d)) {
          disagreements.push(`U+${c.codePointAt(0)!.toString(16)} ~ U+${d.codePointAt(0)!.toString(16)}`)
        }
      }
    }
    expect(disagreements).toEqual([])
    // Not vacuous: the engine does pair code points up (a/A, σ/ς/Σ, k/K/K, …).
    expect(pairs).toBeGreaterThan(2500)
  })

  it("no code point outside that set is matched by a cased literal", () => {
    // So the pairs above are ALL the pairs: an uncased code point matches only
    // itself, which trivially folds to itself.
    const anyCased = new RegExp(`[${cased.map(escapeRegex).join("")}]`, "iu")
    const leaked = others.filter((ch) => anyCased.test(ch))
    expect(leaked).toEqual([])
  })

  it("everything `\\p{M}` matches under `iu` folds to nothing", () => {
    // `\p{M}*` follows every folded letter. Under `iu` it also matches the
    // iota letters, because the combining ypogegrammeni U+0345 case-folds to
    // iota — so the fold has to drop those too.
    const mark = /^\p{M}$/iu
    const kept: string[] = []
    let matched = 0
    for (const ch of [...cased, ...others]) {
      if (!mark.test(ch)) continue
      matched += 1
      if (foldForPrefilter(ch) !== "") kept.push(`U+${ch.codePointAt(0)!.toString(16)}`)
    }
    expect(kept).toEqual([])
    expect(matched).toBeGreaterThan(2000)
    expect(mark.test("ι")).toBe(true) // the reason this test exists
  })

  it("is a homomorphism over the cases that tempt it not to be", () => {
    const parts = ["α", "́", "ς", "Σ", "가", "ᄀ", "ᅡ", "é", "e", "́", "ß", "ẞ", "ſ", "K", "İ", "ı", "שׁ", "ָ"]
    for (const a of parts) {
      for (const b of parts) {
        expect(foldForPrefilter(a + b)).toBe(foldForPrefilter(a) + foldForPrefilter(b))
      }
    }
  })
})

describe("termAnchor", () => {
  it("is the longest run of folded letters and digits in any literal segment", () => {
    expect(termAnchor("Holy Spirit")).toBe("spirit")
    expect(termAnchor("  grac*  ")).toBe("grac")
    expect(termAnchor("son*ship")).toBe("ship")
    expect(termAnchor("χάρις")).toBe("χαρσ") // accent and iota dropped, final sigma folded
    expect(termAnchor("הָאָ֗רֶץ")).toBe("הארץ")
    expect(termAnchor("כָּל־הָאָרֶץ")).toBe("הארץ") // maqaf is punctuation: it splits the run
    expect(termAnchor("Straße")).toBe("strasse") // wider than the regex (ß is not ss to it): the safe side
    expect(termAnchor("ΛΌΓΟΣ")).toBe(termAnchor("λόγος"))
    expect(termAnchor("Psalm 23")).toBe("psalm")
  })

  it("has no anchor for a term with no letter outside its wildcards", () => {
    expect(termAnchor("*")).toBe("")
    expect(termAnchor("**")).toBe("")
    expect(termAnchor("-")).toBe("")
    expect(termAnchor("ι")).toBe("") // iota folds away entirely
    expect(prefilterForTerms(["grace", "*"]).always).toBe(true)
    expect(prefilterForTerms([]).always).toBe(false) // a pattern with no alternate matches nothing
  })
})

function concept(sourceTerm: string, more: Partial<ConceptMatchInput> = {}): ConceptMatchInput {
  return { sourceTerm, ...more }
}

const HEBREW: TermMatchingSettings = { prefixes: ["ו", "ה", "ב", "כ", "ל", "מ", "ש"], suffixes: ["ים", "ות", "י", "ה"], maxAffixes: 2 }
const ENGLISH: TermMatchingSettings = { prefixes: ["un", "re"], suffixes: ["s", "ed", "ing"] }

/**
 * Every shape of term the matcher supports, against texts that do and do not
 * contain it. `expected` is asserted against the reference too, so a row that
 * stopped exercising a match would fail rather than pass vacuously.
 */
const TABLE: Array<{
  name: string
  concept: ConceptMatchInput
  project?: TermMatchingSettings
  text: string
  expected: boolean
}> = [
  { name: "plain word", concept: concept("grace"), text: "by grace alone", expected: true },
  { name: "plain word, absent", concept: concept("grace"), text: "by faith alone", expected: false },
  { name: "whole word only", concept: concept("grace"), text: "graceful disgrace", expected: false },
  { name: "case-insensitive", concept: concept("Grace"), text: "GRACE abounds", expected: true },
  { name: "case-sensitive, other case", concept: concept("Grace", { caseSensitive: true }), text: "grace abounds", expected: false },
  { name: "case-sensitive, same case", concept: concept("Grace", { caseSensitive: true }), text: "Grace abounds", expected: true },
  { name: "trailing wildcard", concept: concept("grac*"), text: "he graced us", expected: true },
  { name: "leading wildcard", concept: concept("*grace"), text: "the disgrace", expected: true },
  { name: "interior wildcard", concept: concept("son*ship"), text: "our sonship", expected: true },
  { name: "wildcard only", concept: concept("*"), text: "anything", expected: true },
  { name: "multi-word", concept: concept("Holy Spirit"), text: "the holy spirit came", expected: true },
  { name: "multi-word, one word present", concept: concept("Holy Spirit"), text: "a holy place", expected: false },
  { name: "punctuated term", concept: concept("a.b"), text: "a.b here", expected: true },
  { name: "digits", concept: concept("Psalm 23"), text: "read psalm 23 aloud", expected: true },
  { name: "listed form", concept: concept("grace", { match: { forms: ["mercy", "favour"] } }), text: "great favour", expected: true },
  { name: "blank form is not an alternate", concept: concept("grace", { match: { forms: ["  ", ""] } }), text: "nothing here", expected: false },
  { name: "excluded form", concept: concept("grace", { match: { excludedForms: ["grace"] } }), text: "by grace", expected: false },
  { name: "affix suffix", concept: concept("walk"), project: ENGLISH, text: "he walked on", expected: true },
  { name: "affix prefix + suffix", concept: concept("turn"), project: ENGLISH, text: "returning home", expected: true },
  { name: "affixes off for the concept", concept: concept("walk", { match: { affixes: false } }), project: ENGLISH, text: "he walked on", expected: false },
  { name: "Hebrew, same pointing", concept: concept("הָאָרֶץ"), text: "וְאֵת הָאָרֶץ", expected: true },
  { name: "Hebrew, unpointed text", concept: concept("הָאָרֶץ"), text: "ואת הארץ", expected: true },
  { name: "Hebrew, other accents", concept: concept("הָאָ֗רֶץ"), text: "וְהָאָ֔רֶץ הָיְתָה", project: HEBREW, expected: true },
  { name: "Hebrew, prefix needs the inventory", concept: concept("הָאָ֗רֶץ"), text: "וְהָאָ֔רֶץ הָיְתָה", expected: false },
  { name: "Hebrew, final form is another letter", concept: concept("מלך"), text: "מלכ", expected: false },
  { name: "Hebrew, maqaf-joined", concept: concept("כָּל"), text: "כָּל־הָאָרֶץ", expected: true },
  { name: "Hebrew, folding off", concept: concept("הָאָרֶץ", { match: { foldMarks: false } }), text: "הארץ", expected: false },
  { name: "Hebrew, excluded pointed form", concept: concept("ארץ", { match: { foldMarks: true, excludedForms: ["אֶרֶץ"] } }), text: "אֶרֶץ", expected: false },
  { name: "Greek, grave for acute", concept: concept("καί"), text: "καὶ εἶπεν", expected: true },
  { name: "Greek, capitalised", concept: concept("λόγος"), text: "Ὁ ΛΌΓΟΣ ἦν", expected: true },
  { name: "Greek, unaccented term does not fold by default", concept: concept("λογος"), text: "ὁ λόγος", expected: false },
  { name: "Greek, fold on", concept: concept("λογος", { match: { foldMarks: true } }), text: "ὁ λόγος", expected: true },
  { name: "Greek, decomposed text", concept: concept("λόγος"), text: "ὁ λόγος".normalize("NFD"), expected: true },
  { name: "Greek, sigma forms are one letter to the regex", concept: concept("λόγοσ"), text: "ὁ λόγος", expected: true },
  { name: "Greek, iota subscript as a mark", concept: concept("τω", { match: { foldMarks: true } }), text: "ἐν τῷ κόσμῳ".normalize("NFD"), expected: true },
  { name: "Greek, a mark-run swallows an iota", concept: concept("λογος", { match: { foldMarks: true } }), text: "λιογος", expected: true },
  { name: "Latin, accent kept by default", concept: concept("ano"), text: "el año", expected: false },
  { name: "Latin, fold on", concept: concept("ano", { match: { foldMarks: true } }), text: "el año", expected: true },
  { name: "Latin, fold on, decomposed text", concept: concept("résumé", { match: { foldMarks: true } }), text: "a resumé here", expected: true },
  { name: "long s", concept: concept("ſin"), text: "Sin entered", expected: true },
  { name: "Kelvin sign", concept: concept("kelvin"), text: "273 Kelvin", expected: true },
  { name: "sharp s, capital", concept: concept("straße"), text: "DIE STRAẞE", expected: true },
  { name: "sharp s is not ss", concept: concept("straße"), text: "die strasse", expected: false },
  { name: "dotted capital I is its own letter", concept: concept("istanbul"), text: "İstanbul", expected: false },
  { name: "dotted capital I, fold on: still its own letter", concept: concept("istanbul", { match: { foldMarks: true } }), text: "İstanbul", expected: false },
  { name: "Cyrillic", concept: concept("благодат*"), text: "Благодать вам", expected: true },
  { name: "CJK, one character", concept: concept("神"), text: "起初神创造天地", expected: false },
  { name: "Hangul, decomposed text", concept: concept("은혜", { match: { foldMarks: true } }), text: "큰 은혜 로".normalize("NFD"), expected: false },
]

describe("prefiltered matcher = unfiltered matcher", () => {
  it.each(TABLE)("$name", ({ concept: c, project, text, expected }) => {
    const reference = referenceMatches(text, c, project)
    expect(referenceTest(text, c, project)).toBe(expected)
    setPrefilterMode("on")
    expect(findConceptMatches(text, c, project)).toEqual(reference)
    expect(matchesConcept(text, c, project)).toBe(expected)
    if (expected) {
      expect(mayMatch(conceptPrefilter(c, project), text)).toBe(true)
      expect(candidateConcepts(text, [c], project)).toEqual([c])
    }
    setPrefilterMode("off")
    expect(findConceptMatches(text, c, project)).toEqual(reference)
    expect(matchesConcept(text, c, project)).toBe(expected)
  })

  it("the table exercises both outcomes and a real rejection", () => {
    expect(TABLE.filter((row) => row.expected).length).toBeGreaterThan(20)
    const rejected = TABLE.filter((row) => !mayMatch(conceptPrefilter(row.concept, row.project), row.text))
    expect(rejected.length).toBeGreaterThanOrEqual(4)
    expect(rejected.every((row) => !row.expected)).toBe(true)
  })

  it("includeExcluded matches go through the same prefilter", () => {
    const c = concept("grace", { match: { excludedForms: ["grace"] } })
    expect(findConceptMatches("by grace", c, undefined, { includeExcluded: true })).toHaveLength(1)
    expect(findConceptMatches("by faith", c, undefined, { includeExcluded: true })).toEqual([])
  })

  it("a plain rendering is found exactly as a fresh regex finds it", () => {
    const cases: Array<[string, string]> = [
      ["por gracia y gracia", "gracia"],
      ["GRACIA", "gracia"],
      ["desgracia", "gracia"],
      ["las gracias", "graci*"],
      ["nada", "gracia"],
      ["Ὁ ΛΌΓΟΣ", "λόγος"],
      ["abc", "*"],
      ["", "gracia"],
      ["gracia", ""],
    ]
    for (const [text, term] of cases) {
      const re = term && text ? buildTermRegex(term, "giu") : null
      const reference: Array<{ start: number; end: number }> = []
      if (re) {
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex += 1
            continue
          }
          reference.push({ start: m.index, end: m.index + m[0].length })
        }
      }
      expect(findPlainTermMatches(text, term)).toEqual(reference)
    }
  })
})

function cell(original: string, translated: string): CellData {
  return {
    id: "c1", original, translated, fileId: "f1", context: "", group: "", type: "text",
    originalHtml: undefined, status: "unvalidated", validationStatus: "none", activeValidators: [],
    validationHistory: [], history: [], threads: [],
  }
}

describe("prefiltered rule engine = unfiltered rule engine", () => {
  it.each(TERMINOLOGY_LINT_PARITY_CASES)("$name", ({ concepts, termMatching, source, target, editor }) => {
    // Fifty concepts that occur nowhere, around the row's own: the row's rules
    // must come out the same, in the same order, with the others skipped.
    const padding: Concept[] = Array.from({ length: 50 }, (_, i) => ({
      id: `pad-${i}`,
      sourceTerm: `zzpadding${i}`,
      renderings: [{ rendering: `qqrendu${i}`, status: "preferred" as const }],
      status: "active" as const,
      createdAt: "2026-10-06T00:00:00.000Z",
    }))
    const all = [...padding.slice(0, 25), ...concepts, ...padding.slice(25)] as Concept[]

    setPrefilterMode("off")
    const reference = checkRulesForCell(cell(source, target), "f1", compileConceptsToRules(all, termMatching))
    setPrefilterMode("on")
    const filtered = checkRulesForCell(cell(source, target), "f1", compileConceptsToRules(all, termMatching))
    expect(filtered).toEqual(reference)
    expect(filtered.map((i) => i.ruleId)).toEqual(editor)

    for (const c of concepts) {
      setPrefilterMode("off")
      const matches = findConceptMatches(source, c, termMatching)
      setPrefilterMode("on")
      expect(findConceptMatches(source, c, termMatching)).toEqual(matches)
      expect(matches).toEqual(referenceMatches(source, c, termMatching))
    }
  })

  it("keeps rule order when gated and ungated rules interleave", () => {
    const concepts = [
      { id: "a", sourceTerm: "alpha", renderings: [{ rendering: "uno", status: "preferred" }], status: "active", createdAt: "" },
      { id: "star", sourceTerm: "*", renderings: [{ rendering: "todo", status: "preferred" }], status: "active", createdAt: "" },
      { id: "b", sourceTerm: "beta", renderings: [{ rendering: "dos", status: "preferred" }, { rendering: "malo", status: "forbidden" }], status: "active", createdAt: "" },
      { id: "c", sourceTerm: "gamma", renderings: [{ rendering: "tres", status: "preferred" }], status: "active", createdAt: "" },
    ] as Concept[]
    const subject = cell("beta and alpha", "malo")
    setPrefilterMode("off")
    const reference = checkRulesForCell(subject, "f1", compileConceptsToRules(concepts))
    setPrefilterMode("on")
    const filtered = checkRulesForCell(subject, "f1", compileConceptsToRules(concepts))
    expect(filtered).toEqual(reference)
    expect(filtered.map((i) => i.ruleId)).toEqual(["term:a:approved", "term:star:approved", "term:b:approved", "term:b:forbidden:malo"])
  })
})

// ── randomized ────────────────────────────────────────────────────────────

/** mulberry32 — small, seeded, good enough to shuffle test data. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Script {
  name: string
  letters: string[]
  marks: string[]
  joiners: string[]
  affixes: TermMatchingSettings
}

const SCRIPTS: Script[] = [
  {
    name: "Hebrew",
    letters: [..."אבגדהוזחטיכלמנסעפצקרשתךםןףץ"],
    // niqqud, dagesh, shin/sin dots, cantillation
    marks: ["ְ", "ִ", "ֵ", "ֶ", "ַ", "ָ", "ֹ", "ּ", "ׁ", "ׂ", "֑", "֗", "֥"],
    joiners: [" ", " ", "־", "׳", "״", ", "],
    affixes: HEBREW,
  },
  {
    name: "Greek",
    letters: [..."αβγδεζηθικλμνξοπρσςτυφχψωΑΕΗΙΟΣΥΩ"],
    // acute, grave, circumflex, smooth, rough, diaeresis, ypogegrammeni
    marks: ["́", "̀", "͂", "̓", "̔", "̈", "ͅ"],
    joiners: [" ", " ", ", ", "· ", "’"],
    affixes: { prefixes: ["συν", "κατα", "ι"], suffixes: ["ος", "ου", "ων", "ς", "ι"], maxAffixes: 1 },
  },
  {
    name: "Latin",
    letters: [..."abcdeiknorstuzABEIKSTßẞſKİıéèñçüøÉ"],
    marks: ["́", "̀", "̃", "̈", "̧", "̇"],
    joiners: [" ", " ", "-", ", ", "'", ". "],
    affixes: ENGLISH,
  },
]

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]
}

function word(random: () => number, script: Script, marked: number): string {
  const length = 1 + Math.floor(random() * 5)
  let out = ""
  for (let i = 0; i < length; i += 1) {
    out += pick(random, script.letters)
    while (random() < marked) out += pick(random, script.marks)
  }
  return out
}

/** The same letters as the regex may see them: re-marked, re-cased, re-normalized. */
function vary(random: () => number, script: Script, base: string): string {
  let out = base
  if (random() < 0.5) {
    // Drop the marks and point the word differently.
    const bare = out.normalize("NFD").replace(/\p{M}+/gu, "")
    out = ""
    for (const ch of bare) {
      out += ch
      while (random() < 0.3) out += pick(random, script.marks)
    }
  }
  const casing = random()
  if (casing < 0.2) out = out.toUpperCase()
  else if (casing < 0.4) out = out.toLowerCase()
  else if (casing < 0.5) out = [...out].map((ch) => (random() < 0.5 ? ch.toUpperCase() : ch.toLowerCase())).join("")
  if (random() < 0.3) out = pick(random, script.affixes.prefixes) + out
  if (random() < 0.3) out = out + pick(random, script.affixes.suffixes)
  const form = random()
  if (form < 0.4) out = out.normalize("NFC")
  else if (form < 0.8) out = out.normalize("NFD")
  return out
}

function randomTerm(random: () => number, script: Script, words: string[]): string {
  let term = pick(random, words)
  if (random() < 0.15) term += pick(random, [" ", "-", "־", "'"]) + pick(random, words)
  const star = random()
  if (star < 0.1) term = `${term}*`
  else if (star < 0.2) term = `*${term}`
  else if (star < 0.26) term = `${pick(random, words)}*${term}`
  else if (star < 0.28) term = "*"
  if (random() < 0.1) term = `  ${term} `
  return term
}

describe("randomized: every concept the regex matches is a candidate", () => {
  it.each(SCRIPTS)("$name — seeded terms and texts", (script) => {
    const random = rng(0x2654 + script.name.length)
    const words = Array.from({ length: 40 }, () => word(random, script, 0.35))
    const concepts: ConceptMatchInput[] = Array.from({ length: 220 }, () => {
      const match: NonNullable<ConceptMatchInput["match"]> = {}
      const fold = random()
      if (fold < 0.4) match.foldMarks = true
      else if (fold < 0.6) match.foldMarks = false
      if (random() < 0.3) match.affixes = random() < 0.5
      if (random() < 0.3) match.forms = [randomTerm(random, script, words), ...(random() < 0.3 ? [" "] : [])]
      if (random() < 0.15) match.excludedForms = [pick(random, words)]
      return {
        sourceTerm: randomTerm(random, script, words),
        ...(Object.keys(match).length > 0 ? { match } : {}),
        ...(random() < 0.15 ? { caseSensitive: true } : {}),
      }
    })
    const texts = Array.from({ length: 160 }, () => {
      const count = 1 + Math.floor(random() * 6)
      let text = ""
      for (let i = 0; i < count; i += 1) {
        const base = random() < 0.75 ? pick(random, words) : word(random, script, 0.35)
        text += (i === 0 ? "" : pick(random, script.joiners)) + vary(random, script, base)
      }
      return text
    })
    const projects: Array<TermMatchingSettings | undefined> = [undefined, script.affixes, { ...script.affixes, foldMarksDefault: true }]

    let matched = 0
    let rejected = 0
    const misses: string[] = []
    for (const project of projects) {
      // The reference: one regex per concept, built by the unfiltered,
      // uncached `buildConceptRegex` and run on every text.
      const references = new Map(
        concepts.map((c) => [c, buildConceptRegex(c, project, c.caseSensitive ? "u" : "iu")] as const),
      )
      for (const text of texts) {
        const candidates = new Set(candidateConcepts(text, concepts, project))
        for (const c of concepts) {
          const hit = references.get(c)?.test(text) ?? false
          const single = mayMatch(conceptPrefilter(c, project), text)
          // The index and the one-at-a-time test are the same predicate.
          if (single !== candidates.has(c)) misses.push(`index≠single: ${JSON.stringify([c, text])}`)
          if (!single) rejected += 1
          if (!hit) continue
          matched += 1
          if (!single) misses.push(JSON.stringify([c, project ?? null, text]))
          else if (matchesConcept(text, c, project) !== true) misses.push(`verdict: ${JSON.stringify([c, text])}`)
        }
      }
    }
    expect(misses).toEqual([])
    // 220 concepts x 160 texts x 3 settings = 105,600 pairs per script. The
    // generator has to keep producing real matches and real rejections, or
    // the assertion above proves nothing.
    expect(matched).toBeGreaterThan(1500)
    expect(rejected).toBeGreaterThan(30000)
  })
})

describe("verify mode", () => {
  it("throws when a rejected pattern matches, and is silent otherwise", () => {
    setPrefilterMode("verify")
    expect(() => verifyRejected("grace", "iu", "by faith")).not.toThrow()
    expect(() => verifyRejected("grace", "giu", "by grace")).toThrow(/prefilter rejected a pattern that matches/)
    setPrefilterMode("on")
    expect(() => verifyRejected("grace", "iu", "by grace")).not.toThrow()
  })
})

describe("the work follows the terms in the text, not the size of the glossary", () => {
  // The benchmark's glossary (scripts/perf/interaction.ts::seedGlossary): 664
  // active terms with forms, affixes and mark folding, twelve of which occur.
  const OCCURRING = ["light", "water", "earth", "heaven", "day", "night", "seed", "tree", "fruit", "sea", "land", "bird"]
  const glossary: Concept[] = Array.from({ length: 664 }, (_, i) => {
    const term = i < OCCURRING.length ? OCCURRING[i] : `countedterm${i}`
    return {
      id: `g${i}`,
      sourceTerm: term,
      status: "active",
      createdAt: "2026-11-19T00:00:00.000Z",
      renderings: [
        { rendering: `rendu${i}`, status: "preferred" },
        { rendering: `variante${i}`, status: "admitted" },
      ],
      match: { foldMarks: true, affixes: true, forms: [`${term}s`, `${term}ed`], excludedForms: [`${term}less`] },
    }
  })
  const project: TermMatchingSettings = { prefixes: ["un", "re"], suffixes: ["s", "ing"] }
  const texts = Array.from({ length: 240 }, (_, i) =>
    `And God said let there be ${OCCURRING[i % 12]} upon the ${OCCURRING[(i * 5 + 3) % 12]}, verse ${i}.`,
  )

  it("compiles a regex only for a concept that is a candidate for some text", () => {
    const before = compiledPatternCount()
    const candidates = new Set<Concept>()
    let highlights = 0
    for (const text of texts) {
      for (const c of candidateConcepts(text, glossary, project)) {
        candidates.add(c)
        highlights += findConceptMatches(text, c, project).length
      }
    }
    expect(candidates.size).toBe(12)
    expect(highlights).toBeGreaterThanOrEqual(240)
    expect(compiledPatternCount() - before).toBeLessThanOrEqual(candidates.size)

    // The whole-glossary loop every other caller still writes costs no more.
    for (const text of texts.slice(0, 20)) for (const c of glossary) matchesConcept(text, c, project)
    expect(compiledPatternCount() - before).toBeLessThanOrEqual(candidates.size)
  })

  it("the rule engine compiles nothing for a term rule whose concept is not in the cell", () => {
    const rules = compileConceptsToRules(glossary, project)
    expect(rules.length).toBe(664)
    const before = compiledPatternCount()
    let infractions = 0
    for (const [i, text] of texts.entries()) {
      infractions += checkRulesForCell({ ...cell(text, "une traduction"), id: `c${i}` }, "f1", rules).length
    }
    expect(infractions).toBeGreaterThanOrEqual(240)
    // Twelve source patterns (shared with the matcher above when it ran first)
    // and their twelve target patterns — not 664 of each.
    expect(compiledPatternCount() - before).toBeLessThanOrEqual(24)
  })

  it("AnchorIndex finds anchors that share a long prefix without scanning them all", () => {
    const index = new AnchorIndex()
    for (let i = 0; i < 2000; i += 1) index.add(i, prefilterForTerms([`sharedprefix${i}`]))
    index.add(2000, prefilterForTerms(["*"]))
    index.add(2001, prefilterForTerms(["fix"]))
    expect(index.candidates("a SharedPrefix1234 b")).toEqual([1, 12, 123, 1234, 2000, 2001])
    expect(index.candidates("nothing")).toEqual([2000])
  })
})
