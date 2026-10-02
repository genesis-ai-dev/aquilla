import { describe, expect, it } from "vitest"
import type { ReferenceScriptureEntry } from "./prompt-build"
import {
  REFERENCE_SCRIPTURE_CHECK_ID,
  checkReferenceScripture,
  normalizeForQuoteMatch,
  quoteOverlap,
} from "./reference-scripture-check"

const KJV: ReferenceScriptureEntry = {
  canonicalRef: "ISA 40:25",
  citedAs: "Isaiah 40:25",
  versionId: "eng-kjv",
  versionLabel: "King James Version (1769), English",
  text: "To whom then will ye liken me, or shall I be equal? saith the Holy One.",
}

describe("checkReferenceScripture (AQU-1573)", () => {
  it("flags a draft that retranslated the verse instead of quoting the reference", () => {
    const findings = checkReferenceScripture(
      "So who could possibly be set alongside the sacred one, he inquires?",
      [KJV],
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      checkId: REFERENCE_SCRIPTURE_CHECK_ID,
      canonicalRef: "ISA 40:25",
      citedAs: "Isaiah 40:25",
      versionId: "eng-kjv",
      expected: KJV.text,
    })
    expect(findings[0].overlap).toBeLessThan(0.6)
  })

  it("passes a draft that carries the reference wording", () => {
    expect(
      checkReferenceScripture(
        'He asks it plainly: "To whom then will ye liken me, or shall I be equal? saith the Holy One."',
        [KJV],
      ),
    ).toEqual([])
  })

  it("passes a partial quotation — a sermon quotes the clause it is preaching on", () => {
    expect(
      checkReferenceScripture("He asks, to whom then will ye liken me, or shall I be equal?", [KJV]),
    ).toEqual([])
  })

  it("ignores punctuation and reflowed whitespace", () => {
    expect(
      checkReferenceScripture(
        "to whom  then will ye liken me — or shall I be equal… saith the Holy One",
        [KJV],
      ),
    ).toEqual([])
  })

  it("ignores Arabic vowel pointing, which a Bible edition has and prose does not", () => {
    const pointed = "فَبِمَنْ تُشَبِّهُونَنِي وَأُسَاوَى، يَقُولُ الْقُدُّوسُ."
    const unpointed = "فبمن تشبهونني وأساوى، يقول القدوس."
    expect(normalizeForQuoteMatch(pointed)).toBe(normalizeForQuoteMatch(unpointed))
    expect(
      checkReferenceScripture(unpointed, [{ ...KJV, versionId: "arb-vandyck", text: pointed }]),
    ).toEqual([])
  })

  it("reports nothing for an empty draft — there is no translation yet to be wrong", () => {
    expect(checkReferenceScripture("", [KJV])).toEqual([])
    expect(checkReferenceScripture(null, [KJV])).toEqual([])
  })

  it("reports nothing when the resolver supplied no verse — that is its own condition", () => {
    expect(checkReferenceScripture("anything at all", [{ ...KJV, text: "" }])).toEqual([])
    expect(checkReferenceScripture("anything at all", [])).toEqual([])
    expect(checkReferenceScripture("anything at all", undefined)).toEqual([])
  })

  it("skips a reference too short to tell reproduction from coincidence", () => {
    expect(checkReferenceScripture("completely unrelated words", [{ ...KJV, text: "Jesus wept." }])).toEqual([])
  })

  it("reports one finding per (version, verse), not one per duplicate entry", () => {
    expect(checkReferenceScripture("unrelated prose entirely", [KJV, KJV])).toHaveLength(1)
  })

  it("honours an explicit threshold", () => {
    const partial = "to whom then will ye liken me"
    expect(checkReferenceScripture(partial, [KJV], { threshold: 0.95 })).toHaveLength(1)
    expect(checkReferenceScripture(partial, [KJV], { threshold: 0.3 })).toEqual([])
  })
})

describe("quoteOverlap", () => {
  it("is 1 when every content word of the reference is present", () => {
    expect(quoteOverlap("alpha beta gamma delta", "alpha beta gamma")).toBe(1)
  })

  it("is 0 when none is", () => {
    expect(quoteOverlap("nothing in common", "alpha beta gamma")).toBe(0)
  })

  it("is 1 for a reference with no content words, so a degenerate verse never fires", () => {
    expect(quoteOverlap("anything", "a I o")).toBe(1)
  })
})
