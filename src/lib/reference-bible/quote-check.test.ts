import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { checkReferenceQuotes, quotedReferenceGroups, sourceVisiblyQuotes, type ReferenceQuoteLookup } from "./quote-check"
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

// Van Dyck verses outside the fixture chapters, copied from db/reference-bibles/arb-vandyck.tsv.gz.
const EXTRA_ARB: Record<string, string> = {
  "MAT 11:28": "تَعَالَوْا إِلَيَّ يا جَمِيعَ ٱلْمُتْعَبِينَ وَٱلثَّقِيلِي ٱلْأَحْمَالِ، وَأَنَا أُرِيحُكُمْ.",
  "ROM 5:8": "وَلَكِنَّ ٱللهَ بَيَّنَ مَحَبَّتَهُ لَنَا، لِأَنَّهُ وَنَحْنُ بَعْدُ خُطَاةٌ مَاتَ ٱلْمَسِيحُ لِأَجْلِنَا.",
  "JHN 15:13": "لَيْسَ لِأَحَدٍ حُبٌّ أَعْظَمُ مِنْ هَذَا: أَنْ يَضَعَ أَحَدٌ نَفْسَهُ لِأَجْلِ أَحِبَّائِهِ.",
  "PHP 4:13": "أَسْتَطِيعُ كُلَّ شَيْءٍ فِي ٱلْمَسِيحِ ٱلَّذِي يُقَوِّينِي.",
}
const arbPlus: ReferenceQuoteLookup = (c) => (EXTRA_ARB[c] ? [EXTRA_ARB[c]] : arb.lookup(c))

describe("checkReferenceQuotes: the ends of a quote (AQU-1573 review)", () => {
  const source316 = "\"For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life\" (John 3:16)."
  const kinds = (source: string, draft: string, lookup = arb.lookup) => checkReferenceQuotes(source, draft, lookup).map((f) => f.kind)

  it("flags a changed last word, inside or outside quotation marks", () => {
    const kjvChanged = kjv.verse("JHN", 3, 16).replace("everlasting life.", "everlasting joy.")
    expect(kinds(source316, kjvChanged, kjv.lookup)).toEqual(["differs"])
    expect(kinds(source316, `"${kjvChanged}" (John 3:16).`, kjv.lookup)).toEqual(["differs"])
    const arbChanged = unvowelled(JHN316).replace(/الأبدية\.?$/, "الدائمة.")
    expect(arbChanged).not.toBe(unvowelled(JHN316))
    expect(kinds(source316, `«${arbChanged}»`)).toEqual(["differs"])
    expect(kinds(source316, arbChanged)).toEqual(["differs"])
  })

  it("flags the last two words or the first word changed", () => {
    const lastTwo = unvowelled(JHN316).replace(/الحياة الأبدية\.?$/, "حياة دائمة.")
    expect(lastTwo).not.toBe(unvowelled(JHN316))
    expect(kinds(source316, `«${lastTwo}»`)).toEqual(["differs"])
    expect(kinds(source316, lastTwo)).toEqual(["differs"])
    const firstWord = unvowelled(JHN316).replace(/^لأنه/, "إذ")
    expect(firstWord).not.toBe(unvowelled(JHN316))
    expect(kinds(source316, `«${firstWord}»`)).toEqual(["differs"])
    expect(kinds(source316, firstWord)).toEqual(["differs"])
  })

  it("marks the changed end word in the span", () => {
    const changed = unvowelled(JHN316).replace(/الأبدية\.?$/, "الدائمة.")
    const draft = `قال يسوع: «${changed}»`
    const [f] = checkReferenceQuotes(source316, draft, arb.lookup) as { targetStart: number; targetEnd: number }[]
    expect(draft.slice(f.targetStart, f.targetEnd)).toContain("الدائمة")
    expect(draft.slice(f.targetStart, f.targetEnd)).not.toContain("يسوع")
  })

  it("flags a quote that copies the opening and paraphrases the rest", () => {
    const source = "Jesus said, \"Come to me, all you who are weary and burdened, and I will give you rest\" (Matthew 11:28)."
    const draft = "«تعالوا إليّ يا جميع المتعبين والمثقلين، وأنا أمنحكم الراحة»"
    expect(kinds(source, draft, arbPlus)).toEqual(["differs"])
  })

  it("flags a fresh translation that happens to share three words of the verse", () => {
    const source = "Paul writes, \"while we were still sinners, Christ died for us\" (Romans 5:8)."
    expect(kinds(source, "«بينما كنا لا نزال خطاة، مات المسيح من أجلنا»", arbPlus)).toEqual(["differs"])
    expect(kinds(source, "بينما كنا لا نزال خطاة، مات المسيح من أجلنا", arbPlus)).toEqual(["differs"])
  })

  it("still passes a partial quote, a lead-in, a cited reference and a verse's own quotation marks", () => {
    const words = unvowelled(JHN316).split(" ")
    // Words left out at either end of the quote.
    expect(kinds(source316, `«${words.slice(0, 6).join(" ")}»`)).toEqual([])
    expect(kinds(source316, `«${words.slice(3).join(" ")}»`)).toEqual([])
    // A leading و added or dropped at the first word.
    expect(kinds(source316, `«و${words.join(" ")}»`)).toEqual([])
    // Lead-in and reference outside the marks; a reference in brackets inside them.
    expect(kinds(source316, `قال يسوع لنيقوديموس: «${JHN316}» (يوحنا 3: 16).`)).toEqual([])
    expect(kinds(source316, `«${JHN316} (يوحنا 3: 16)»`)).toEqual([])
    // Unquoted, the verse running into the draft's own sentence after punctuation.
    expect(kinds(source316, `${JHN316} وهذا هو قلب الإنجيل.`)).toEqual([])
    // A verse that carries its own «…», quoted inside the draft's «…».
    const source = "Isaiah 40:25 says, \"To whom then will ye liken me, or shall I be equal?\""
    const isa = arb.verse("ISA", 40, 25)
    expect(kinds(source, `يقول إشعياء: «${isa}»`)).toEqual([])
  })

  it("does not apply the unquoted end check to a verse the source only mentions", () => {
    // Shares a run with Romans 8:28 but the source does not quote it.
    const source = "Later we'll look at Romans 8:28 together."
    const draft = `سننظر لاحقا معا في ${unvowelled(ROM828).split(" ").slice(0, 6).join(" ")} اليوم`
    expect(kinds(source, draft)).toEqual([])
  })
})

describe("checkReferenceQuotes: what counts as the source quoting a verse (AQU-1573 review)", () => {
  it("stays quiet when the source quotes someone else and only mentions a verse", () => {
    const source = "As Spurgeon said, \"Faith is the hand that receives.\" Later we'll look at Philippians 4:13."
    expect(checkReferenceQuotes(source, "ترجمة جديدة لا تستعمل كلمات الآية", arbPlus)).toEqual([])
    expect(checkReferenceQuotes(source, "كما قال سبرجن: «الإيمان هو اليد التي تأخذ». سننظر لاحقا في فيلبي 4: 13.", arbPlus)).toEqual([])
    const tagged = "As Spurgeon said, \"Faith is the hand that receives.\" Philippians 4:13 reminds us we can do all things."
    expect(checkReferenceQuotes(tagged, "ترجمة جديدة تماما لا علاقة لها بالآية", arbPlus)).toEqual([])
  })

  it("names only the reference that cites the quotation, not a see-also", () => {
    const source = "Paul writes, \"while we were still sinners, Christ died for us\" (Romans 5:8; see also John 15:13)."
    expect(checkReferenceQuotes(source, "ترجمة جديدة لا تستعمل كلمات الآية", arbPlus)).toEqual([
      expect.objectContaining({ kind: "missing", canonicals: ["ROM 5:8"], labels: ["Romans 5:8"] }),
    ])
  })

  it("flags each quotation the draft leaves out, even when another one is copied", () => {
    const source = "\"For God so loved the world\" (John 3:16). And Paul: \"while we were still sinners, Christ died for us\" (Romans 5:8)."
    const findings = checkReferenceQuotes(source, `«${JHN316}» ثم ترجمة جديدة لكلام بولس هنا`, arbPlus)
    expect(findings).toEqual([expect.objectContaining({ kind: "missing", canonicals: ["ROM 5:8"] })])
  })
})

describe("quotedReferenceGroups / sourceVisiblyQuotes (AQU-1573)", () => {
  const refs = (s: string) => findScriptureReferences(s)
  const groups = (s: string) => quotedReferenceGroups(s, refs(s)).map((g) => g.map((r) => r.canonical))
  it("needs three quoted words or a bracketed reference after three words", () => {
    const yes = [
      "Isaiah 40:25 says, “To whom will you compare me?”",
      "«To whom then will» Isaiah 40:25",
      "God so loved the world (John 3:16)",
      "\"While we were still sinners,\" says Paul in Romans 5:8.",
    ]
    for (const s of yes) expect(sourceVisiblyQuotes(s, refs(s))).toBe(true)
    const no = [
      "Isaiah 40:25 says \"Holy\" twice",
      "See (John 3:16)",
      "Read John 3:16 tonight, don't wait, it's good",
      "As Spurgeon said, \"Faith is the hand that receives.\" Later we'll look at Philippians 4:13.",
      "\"Faith is the hand that receives,\" and Philippians 4:13 agrees with that.",
      "Romans 8:28 is a promise. Then the pastor said, \"we will look at it next week\".",
    ]
    for (const s of no) expect(sourceVisiblyQuotes(s, refs(s))).toBe(false)
  })

  it("groups a cited list with its quotation", () => {
    expect(groups("Romans 8:28; John 3:16 show us: \"For God so loved the world\"")).toEqual([["ROM 8:28", "JHN 3:16"]])
    expect(groups("\"For God so loved the world\" (John 3:16, 18)")).toEqual([["JHN 3:16", "JHN 3:18"]])
    expect(groups("\"For God so loved the world\" (John 3:16; see also Romans 5:8)")).toEqual([["JHN 3:16"]])
  })
})
