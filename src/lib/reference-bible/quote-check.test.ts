import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { checkReferenceQuotes, sourceVisiblyQuotes, type ReferenceQuoteLookup } from "./quote-check"
import { findScriptureReferences, parseCanonicalRef } from "./reference-finder"
import { extractUsfmVerses } from "./usfm-verses"

// Real Van Dyck and KJV text (ISA 40, PSA 23 + 51, JHN 3, ROM 8, 1CO 13).
function bible(file: string) {
  const rows = extractUsfmVerses(readFileSync(path.join(__dirname, "__fixtures__", file), "utf8"))
  const verse = (book: string, chapter: number, v: number) =>
    rows.find((r) => r.book === book && r.chapter === chapter && r.verse === v)!.text
  const lookup: ReferenceQuoteLookup = (canonical) => {
    const ref = parseCanonicalRef(canonical)
    if (!ref) return undefined
    const texts = rows
      .filter(
        (r) =>
          r.book === ref.book &&
          (r.chapter > ref.chapter || (r.chapter === ref.chapter && r.verse >= ref.verseStart)) &&
          (r.chapter < ref.endChapter || (r.chapter === ref.endChapter && r.verse <= ref.verseEnd)),
      )
      .map((r) => r.text)
    return texts.length ? texts : undefined
  }
  return { verse, lookup }
}

const arb = bible("arb-vd-sample.usfm")
const kjv = bible("eng-kjv-sample.usfm")
/** What a writer who does not type vowel marks produces. */
const unvowelled = (s: string) => s.replace(/\p{M}/gu, "").replace(/ٱ/g, "ا")

const ROM828 = arb.verse("ROM", 8, 28)
const JHN316 = arb.verse("JHN", 3, 16)

describe("checkReferenceQuotes (AQU-1573)", () => {
  const source316 = "\"For God so loved the world that he gave his one and only Son\" (John 3:16)."

  it("passes an exact vowelled quote with a lead-in", () => {
    expect(checkReferenceQuotes(source316, `يقول الكتاب: «${JHN316}»`, arb.lookup)).toEqual([])
  })

  it("passes an unvowelled quote and other quotation marks", () => {
    expect(checkReferenceQuotes(source316, `“${unvowelled(JHN316)}”`, arb.lookup)).toEqual([])
  })

  it("passes a partial quote that matches", () => {
    const source = "1 Cor. 13:4–7 tells us, \"Love is patient, love is kind.\""
    const draft = `تقول رسالة كورنثوس الأولى: «${unvowelled("ٱلْمَحَبَّةُ تَتَأَنَّى وَتَرْفُقُ.")}»`
    expect(checkReferenceQuotes(source, draft, arb.lookup)).toEqual([])
  })

  it("passes when a leading conjunction is dropped at the edge", () => {
    const source = "Romans 8:28: \"And we know that in all things God works for the good\""
    const draft = `«${unvowelled(ROM828).replace(/^ونحن/, "نحن")}»`
    expect(checkReferenceQuotes(source, draft, arb.lookup)).toEqual([])
  })

  it("flags one word changed in the middle, spanning the quoted part", () => {
    const source = "Romans 8:28: \"And we know that in all things God works for the good\""
    const changed = unvowelled(ROM828).replace("للخير", "للصلاح")
    expect(changed).not.toBe(unvowelled(ROM828))
    const draft = `يقول بولس: «${changed}»`
    const findings = checkReferenceQuotes(source, draft, arb.lookup)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: "differs", canonical: "ROM 8:28", label: "Romans 8:28" })
    const f = findings[0] as { targetStart: number; targetEnd: number }
    expect(draft.slice(f.targetStart, f.targetEnd)).toContain("للصلاح")
    expect(draft.slice(f.targetStart, f.targetEnd)).not.toContain("بولس")
  })

  it("flags an extra word inside the quote", () => {
    const words = unvowelled(JHN316).split(" ")
    words.splice(5, 0, "حقا")
    const findings = checkReferenceQuotes(source316, words.join(" "), arb.lookup)
    expect(findings.map((f) => f.kind)).toEqual(["differs"])
  })

  it("flags a fresh translation only when the source visibly quotes", () => {
    const fresh = "الرب هو راعيّ، لن أحتاج إلى شيء"
    const quoted = "The psalmist writes, \"The Lord is my shepherd, I lack nothing\" (Ps 23:1)."
    expect(checkReferenceQuotes(quoted, fresh, arb.lookup)).toEqual([
      expect.objectContaining({ kind: "missing", canonicals: ["PSA 23:1"], labels: ["Psalm 23:1"] }),
    ])
    const f = checkReferenceQuotes(quoted, fresh, arb.lookup)[0] as { sourceStart: number; sourceEnd: number }
    expect(quoted.slice(f.sourceStart, f.sourceEnd)).toBe("Ps 23:1")
    // Reference in brackets after the quoted words, no quotation marks.
    expect(checkReferenceQuotes("The Lord is my shepherd, I lack nothing (Psalm 23:1)", fresh, arb.lookup)).toHaveLength(1)
  })

  it("stays quiet when the source only mentions a verse", () => {
    const source = "Later we'll look at Romans 8:28 together."
    expect(checkReferenceQuotes(source, "سننظر لاحقا معا في رومية ٨: ٢٨.", arb.lookup)).toEqual([])
  })

  it("stays quiet when one verse of a list is quoted", () => {
    const source = "Romans 8:28; John 3:16 show us: \"For God so loved the world\""
    expect(checkReferenceQuotes(source, `«${JHN316}»`, arb.lookup)).toEqual([])
  })

  it("splits a quote at an ellipsis or a bracketed insertion", () => {
    const words = unvowelled(JHN316).split(" ")
    const ellipsis = `«${words.slice(0, 5).join(" ")} … ${words.slice(-5).join(" ")}»`
    expect(checkReferenceQuotes(source316, ellipsis, arb.lookup)).toEqual([])
    const bracketed = `«${words.slice(0, 5).join(" ")} [أي البشر] ${words.slice(6).join(" ")}»`
    expect(checkReferenceQuotes(source316, bracketed, arb.lookup)).toEqual([])
  })

  it("ignores the KJV's LORD versus Lord, and flags a changed KJV word", () => {
    const source = "\"The Lord is my shepherd, I lack nothing\" (Psalm 23:1)"
    expect(checkReferenceQuotes(source, "The Lord is my shepherd; I shall not want.", kjv.lookup)).toEqual([])
    const romans = "Romans 8:28: \"And we know that in all things God works for the good\""
    const changed = kjv.verse("ROM", 8, 28).replace("work together for good", "work together for the best")
    expect(checkReferenceQuotes(romans, changed, kjv.lookup).map((f) => f.kind)).toEqual(["differs"])
    expect(checkReferenceQuotes(romans, kjv.verse("ROM", 8, 28), kjv.lookup)).toEqual([])
  })

  it("skips references whose verses are not loaded and empty drafts", () => {
    expect(checkReferenceQuotes(source316, "anything at all here", () => undefined)).toEqual([])
    expect(checkReferenceQuotes(source316, "   ", arb.lookup)).toEqual([])
    expect(checkReferenceQuotes("No reference \"at all in this one\"", "شيء", arb.lookup)).toEqual([])
  })

  it("accepts references found earlier by the caller", () => {
    const refs = findScriptureReferences(source316)
    expect(checkReferenceQuotes(source316, "كلام آخر تماما لا علاقة له", arb.lookup, { references: refs })).toEqual([
      expect.objectContaining({ kind: "missing", canonicals: ["JHN 3:16"] }),
    ])
  })
})

describe("sourceVisiblyQuotes (AQU-1573)", () => {
  const refs = (s: string) => findScriptureReferences(s)
  it("needs three quoted words or a bracketed reference after three words", () => {
    const yes = ["Isaiah 40:25 says, “To whom will you compare me?”", "«To whom then will» Isaiah 40:25", "God so loved the world (John 3:16)"]
    for (const s of yes) expect(sourceVisiblyQuotes(s, refs(s))).toBe(true)
    const no = ["Isaiah 40:25 says \"Holy\" twice", "See (John 3:16)", "Read John 3:16 tonight, don't wait, it's good"]
    for (const s of no) expect(sourceVisiblyQuotes(s, refs(s))).toBe(false)
  })
})
