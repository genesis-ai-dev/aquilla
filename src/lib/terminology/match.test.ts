import { describe, it, expect } from "vitest"
import { termToRegexSource, buildTermRegex, matchesTerm, conceptToRegexSource, findConceptMatches, matchesConcept } from "./match"

describe("matchesTerm — inflectional wildcard", () => {
  // WHY: the whole feature is that a managed source term `grac*` should catch
  // inflected forms a translator actually writes (grace, graced, graces) AND
  // cross-script inflections (gracia). If this regresses, enforcement/chips
  // silently miss inflected terms — the exact gap this work closes.
  it("`grac*` matches the inflected forms but not unrelated words", () => {
    expect(matchesTerm("by grace alone", "grac*")).toBe(true)
    expect(matchesTerm("he graced us", "grac*")).toBe(true)
    expect(matchesTerm("many graces", "grac*")).toBe(true)
    expect(matchesTerm("por gracia", "grac*")).toBe(true)
    // Must NOT fire on a word that merely shares letters but isn't a grac- form.
    expect(matchesTerm("the disgrace", "grac*")).toBe(false) // leading boundary
    expect(matchesTerm("grid", "grac*")).toBe(false)
  })

  // WHY: backward compatibility. Existing managed terms have no `*`; they must
  // keep matching as exact whole words or every old enforcement rule shifts.
  it("a term with no `*` stays exact whole-word (backward compat)", () => {
    expect(matchesTerm("the Lord said", "Lord")).toBe(true)
    expect(matchesTerm("lordship", "Lord")).toBe(false) // no inflection without *
    expect(matchesTerm("overlord", "Lord")).toBe(false) // leading boundary
  })

  // WHY: leading `*` is a prefix gap — match a form with anything before it.
  it("leading `*grace` matches a prefix run", () => {
    expect(matchesTerm("disgrace", "*grace")).toBe(true)
    expect(matchesTerm("grace", "*grace")).toBe(true)
    expect(matchesTerm("graceful", "*grace")).toBe(false) // no trailing inflection
  })

  // WHY: interior `*` is a gap between two literal parts (compound/affix forms).
  it("interior `*` is a letter-run gap", () => {
    expect(matchesTerm("sonship", "son*ship")).toBe(true)
    expect(matchesTerm("son to ship", "son*ship")).toBe(false) // gap is letters only, not space
  })

  // WHY: experts type in mixed case; matching must be case-insensitive.
  it("is case-insensitive by default and honors caseSensitive", () => {
    expect(matchesTerm("GRACE abounds", "grac*")).toBe(true)
    expect(matchesTerm("Grace", "GRACE")).toBe(true)
    expect(matchesTerm("Grace", "grace", { caseSensitive: true })).toBe(false)
    expect(matchesTerm("grace", "grace", { caseSensitive: true })).toBe(true)
  })

  // WHY: source/target text is non-Latin for most projects. \p{L} (not \w) is
  // why this works across scripts — a regression to \w would break this.
  it("is unicode-aware across scripts", () => {
    expect(matchesTerm("χάρις δίδοται", "χάρι*")).toBe(true) // Greek inflection
    expect(matchesTerm("благодать", "благодат*")).toBe(true) // Cyrillic
  })

  // WHY: terms are user data and must never be interpreted as regex. `a.b`
  // must match the literal "a.b", not "axb" — else a stray `.` in a term
  // would over-match arbitrary text.
  it("is regex-injection safe", () => {
    expect(matchesTerm("a.b here", "a.b")).toBe(true)
    expect(matchesTerm("axb here", "a.b")).toBe(false)
    expect(matchesTerm("(grace)", "(grace)")).toBe(true)
  })

  // WHY: empty/whitespace terms must never match (would warn on everything).
  it("handles empty/whitespace terms safely", () => {
    expect(termToRegexSource("")).toBeNull()
    expect(termToRegexSource("   ")).toBeNull()
    expect(buildTermRegex("")).toBeNull()
    expect(matchesTerm("anything", "")).toBe(false)
    expect(matchesTerm("anything", "   ")).toBe(false)
    expect(matchesTerm("", "grace")).toBe(false)
  })

  it("termToRegexSource produces the documented boundary/wildcard shape", () => {
    expect(termToRegexSource("Lord")).toBe("(?<![\\p{L}\\p{M}])Lord(?![\\p{L}\\p{M}])")
    // WHY: the wildcard now spans marks as well as letters (AQU-1271), since
    // `[\p{L}\p{M}]*` is a strict superset of the old `\p{L}*` — every term
    // that matched before still matches (asserted behaviourally by the other
    // tests in this file); this only documents the updated regex shape.
    expect(termToRegexSource("grac*")).toBe("(?<![\\p{L}\\p{M}])grac[\\p{L}\\p{M}]*")
    // leading `*` becomes a prefix letter/mark-run (and naturally drops the
    // leading boundary), so `*grace` = "any letter/mark-run then grace then
    // word boundary".
    expect(termToRegexSource("*grace")).toBe("[\\p{L}\\p{M}]*grace(?![\\p{L}\\p{M}])")
  })
})

describe("mark folding (foldMarks)", () => {
  const term = "הָאָ֗רֶץ" // as selected in Gen 1:1, with revia accent

  // WHY: the bug that started AQU-1271. A term selected with one accent must
  // match the same word under another accent, or with no accent at all.
  it("matches the same consonants under different pointing", () => {
    expect(matchesTerm("הָאָ֑רֶץ", term, { foldMarks: true })).toBe(true)
    expect(matchesTerm("הָאָרֶץ", term, { foldMarks: true })).toBe(true)
    expect(matchesTerm("הארץ", term, { foldMarks: true })).toBe(true)
  })

  // WHY: without folding, behaviour must be byte-exact as before, so turning
  // the option off restores the old semantics for projects that rely on it.
  it("without foldMarks the old exact-pointing behaviour stands", () => {
    expect(matchesTerm("הָאָ֑רֶץ", term)).toBe(false)
    expect(matchesTerm(term, term)).toBe(true)
  })

  // WHY: editor decorations use match offsets. Folding must be done inside the
  // regex so the match spans the original pointed text, not a stripped copy.
  it("reports offsets in the original (pointed) haystack", () => {
    const hay = "בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָֽרֶץ׃"
    const re = buildTermRegex(term, "giu", { foldMarks: true })!
    const m = re.exec(hay)!
    expect(hay.slice(m.index, m.index + m[0].length)).toBe("הָאָֽרֶץ")
  })

  // WHY: the sheva before ה is a mark, so the leading boundary already passed
  // on וְהָאָ֗רֶץ by accident. With folding that accident must not become a
  // regression in the other direction: a plain consonantal ו IS a letter and
  // must block the match until affixes (Task 3) allow it.
  it("a prefixed consonant still blocks the leading boundary", () => {
    expect(matchesTerm("והארץ", term, { foldMarks: true })).toBe(false)
  })
})

describe("wildcard spans marks", () => {
  // WHY: `*` used to expand to letters only, so `הָאָ*` stopped at the first
  // vowel point. A wildcard is "the rest of the word", marks included.
  it("`*` consumes letters and combining marks", () => {
    expect(matchesTerm("הָאָ֗רֶץ", "הָאָ*")).toBe(true)
    // Backward compat: Latin inflection unchanged.
    expect(matchesTerm("graced", "grac*")).toBe(true)
    expect(matchesTerm("grid", "grac*")).toBe(false)
  })
})

describe("affixes", () => {
  const project = { prefixes: ["ו", "ה", "ב", "כ", "ל", "מ"], suffixes: ["ים", "י"], maxAffixes: 2 }
  const concept = { sourceTerm: "הָאָ֗רֶץ" }

  // WHY: the user's Gen 1:1 case. Prefixed forms must match once the project
  // says which prefixes exist; the code knows nothing about Hebrew.
  it("matches prefixed forms from the project inventory", () => {
    expect(matchesConcept("וְהָאָ֗רֶץ", concept, project)).toBe(true)
    expect(matchesConcept("והארץ", concept, project)).toBe(true)
    // ב replaces ה here (בָּאָ֣רֶץ has no article), so it must NOT match this term.
    expect(matchesConcept("בָּאָ֣רֶץ", concept, project)).toBe(false)
  })

  // WHY: chaining is bounded so a long run of prefix letters cannot swallow an
  // unrelated word that merely ends in the term.
  it("respects maxAffixes", () => {
    const one = { ...project, maxAffixes: 1 }
    expect(matchesConcept("ולהארץ", concept, one)).toBe(false)
    expect(matchesConcept("ולהארץ", concept, project)).toBe(true)
  })

  // WHY: per-concept opt-out. A proper noun should not absorb prefixes even in
  // an affix-heavy project.
  it("a concept can opt out with match.affixes=false", () => {
    expect(matchesConcept("והארץ", { ...concept, match: { affixes: false } }, project)).toBe(false)
  })

  // WHY: Latin suffixes, to prove nothing is script-specific.
  it("works for Latin suffix inventories", () => {
    const en = { prefixes: [], suffixes: ["s", "es", "ed", "ing"] }
    expect(matchesConcept("the graces", { sourceTerm: "grace" }, en)).toBe(true)
    expect(matchesConcept("disgrace", { sourceTerm: "grace" }, en)).toBe(false)
  })
})

describe("affix list hygiene", () => {
  // WHY: folding collapses spellings, so the raw inventory a user types can
  // produce duplicate or EMPTY alternatives in the affix group. An empty
  // alternative makes `(?:…|)` match the empty string at every position, which
  // silently turns the bounded affix group into a wildcard and makes the term
  // match words it has no business matching. Dedupe must happen after folding.
  it("dedupes folded affixes and never emits an empty alternative", () => {
    const src = termToRegexSource("\u05d0\u05e8\u05e5", {
      foldMarks: true,
      prefixes: ["\u05d9\u05dd", "\u05d9\u05b4\u05dd", "\u05b0"],
      suffixes: [],
      maxAffixes: 2,
    })
    expect(src).not.toBeNull()
    const group = src as string
    // \u05d9\u05dd and \u05d9\u05b4\u05dd fold to one pattern, so it appears exactly once…
    const alt = "\u05d9\\p{M}*\u05dd\\p{M}*"
    expect(group.split(alt).length - 1).toBe(1)
    // …and the mark-only affix contributes no empty alternative.
    expect(group).not.toContain("|)")
    expect(group).not.toContain("(?:|")
    expect(() => new RegExp(group, "u")).not.toThrow()
  })
})

describe("forms and exclusions", () => {
  // WHY: manual variants are the escape hatch when no option covers a form.
  it("match.forms are alternates with their own boundaries", () => {
    const c = { sourceTerm: "אֶרֶץ", match: { forms: ["אָרֶץ"] } }
    expect(matchesConcept("הָאָרֶץ", c, { prefixes: ["ה"], suffixes: [] })).toBe(true)
  })

  // WHY: the discovered-forms chip UX writes excludedForms; excluding a surface
  // form must remove it everywhere the matcher is used (rules, chips, counts).
  it("excludedForms suppress a whole surface form", () => {
    const project = { prefixes: ["ו", "ה"], suffixes: [] }
    const c = { sourceTerm: "הארץ", match: { excludedForms: ["והארץ"] } }
    expect(matchesConcept("הארץ", c, project)).toBe(true)
    expect(matchesConcept("והארץ", c, project)).toBe(false)
    // Exclusion is compared folded when foldMarks is on.
    const pointed = { sourceTerm: "הָאָ֗רֶץ", match: { excludedForms: ["וְהָאָ֗רֶץ"] } }
    expect(matchesConcept("וְהָאָֽרֶץ", pointed, project)).toBe(false)
  })

  // WHY: discoverForms needs to list excluded forms so they can be re-included.
  it("findConceptMatches can include excluded forms on request", () => {
    const project = { prefixes: ["ו"], suffixes: [] }
    const c = { sourceTerm: "הארץ", match: { excludedForms: ["והארץ"] } }
    expect(findConceptMatches("והארץ הארץ", c, project).map((m) => m.surface)).toEqual(["הארץ"])
    expect(findConceptMatches("והארץ הארץ", c, project, { includeExcluded: true }).map((m) => m.surface)).toEqual(["והארץ", "הארץ"])
  })

  // WHY: regex-injection safety extends to forms, affixes and exclusions.
  it("escapes regex metacharacters in forms, affixes and exclusions", () => {
    const c = { sourceTerm: "a.b", match: { forms: ["c+d"], excludedForms: ["(x)"] } }
    expect(matchesConcept("axb", c, { prefixes: ["["], suffixes: [] })).toBe(false)
    expect(matchesConcept("c+d", c)).toBe(true)
    expect(conceptToRegexSource(c)).not.toBeNull()
  })

  // WHY: compile.ts hands the rule engine ONE sourcePattern; everything above
  // must be expressible as a single regex source.
  it("conceptToRegexSource returns a single compilable pattern", () => {
    const src = conceptToRegexSource(
      { sourceTerm: "הָאָ֗רֶץ", match: { forms: ["אֶרֶץ"], excludedForms: ["והארץ"] } },
      { prefixes: ["ו", "ה"], suffixes: ["ים"] },
    )!
    expect(() => new RegExp(src, "giu")).not.toThrow()
  })
})
