import { describe, it, expect } from "vitest"
import { termToRegexSource, buildTermRegex, matchesTerm } from "./match"

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
    expect(termToRegexSource("Lord")).toBe("(?<!\\p{L})Lord(?!\\p{L})")
    // WHY: the wildcard now spans marks as well as letters (AQU-1271), since
    // `[\p{L}\p{M}]*` is a strict superset of the old `\p{L}*` — every term
    // that matched before still matches (asserted behaviourally by the other
    // tests in this file); this only documents the updated regex shape.
    expect(termToRegexSource("grac*")).toBe("(?<!\\p{L})grac[\\p{L}\\p{M}]*")
    // leading `*` becomes a prefix letter/mark-run (and naturally drops the
    // leading boundary), so `*grace` = "any letter/mark-run then grace then
    // word boundary".
    expect(termToRegexSource("*grace")).toBe("[\\p{L}\\p{M}]*grace(?!\\p{L})")
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
