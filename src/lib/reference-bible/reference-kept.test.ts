import { describe, expect, it } from "vitest"
import { findDroppedReferences, keepsReference, numbersIn } from "./reference-kept"
import { parseCanonicalRef } from "./reference-finder"

// AQU-1573: a translation must keep the chapter and verse numbers of every
// reference its source cites. Book names are never compared.

const ISA = 'Isaiah 40:25 says, "To whom will you compare me? Or who is my equal?" says the Holy One.'
const VD_ISA_40_25 = "«فَبِمَنْ تُشَبِّهُونَنِي فَأُسَاوِيَهُ؟» يَقُولُ ٱلْقُدُّوسُ."

const dropped = (source: string, target: string) => findDroppedReferences(source, target).map((d) => d.label)

describe("numbersIn", () => {
  it("reads Western, Arabic-Indic and Eastern Arabic-Indic digits", () => {
    expect(numbersIn("40:25")).toEqual([40, 25])
    expect(numbersIn("٤٠:٢٥")).toEqual([40, 25])
    expect(numbersIn("۴۰:۲۵")).toEqual([40, 25])
    expect(numbersIn("no numbers")).toEqual([])
  })
})

describe("keepsReference", () => {
  const ref = (canonical: string) => parseCanonicalRef(canonical)!
  it("needs the chapter and then the first verse", () => {
    expect(keepsReference([40, 25], ref("ISA 40:25"))).toBe(true)
    expect(keepsReference([25, 40], ref("ISA 40:25"))).toBe(false)
    expect(keepsReference([40], ref("ISA 40:25"))).toBe(false)
    expect(keepsReference([40, 40], ref("PSA 40:40"))).toBe(true)
    expect(keepsReference([40], ref("PSA 40:40"))).toBe(false)
  })
})

describe("findDroppedReferences", () => {
  it("passes the reference written in any digits and with any separator", () => {
    for (const target of [
      `يقول إشعياء 40:25: ${VD_ISA_40_25}`,
      `يقول إشعياء 40: 25: ${VD_ISA_40_25}`,
      `يقول إشعياء 40.25: ${VD_ISA_40_25}`,
      `يقول إشعياء ٤٠:٢٥: ${VD_ISA_40_25}`,
      `يقول إشعياء ۴۰:۲۵: ${VD_ISA_40_25}`,
    ]) {
      expect(dropped(ISA, target), target).toEqual([])
    }
  })

  it("passes the spoken form, with words between chapter and verse", () => {
    const source = "John chapter 3, verse 16 is the verse many of us learned first."
    expect(dropped(source, "يوحنا الأصحاح 3، الآية 16 هي الآية التي تعلمها الكثير منا أولاً.")).toEqual([])
    expect(dropped(source, "يوحنا الأصحاح ٣، الآية ١٦ هي الآية التي تعلمها الكثير منا أولاً.")).toEqual([])
  })

  it("flags a translation that copies the quote but leaves out the reference", () => {
    const found = findDroppedReferences(ISA, `يقول إشعياء: ${VD_ISA_40_25}`)
    expect(found).toEqual([{ canonical: "ISA 40:25", label: "Isaiah 40:25", sourceStart: 0, sourceEnd: "Isaiah 40:25".length }])
  })

  it("flags the right numbers for the wrong verse, and the numbers in the wrong order", () => {
    expect(dropped(ISA, `يقول إشعياء 40: 26: ${VD_ISA_40_25}`)).toEqual(["Isaiah 40:25"])
    expect(dropped(ISA, `يقول إشعياء 25: 40: ${VD_ISA_40_25}`)).toEqual(["Isaiah 40:25"])
  })

  it("needs only the verse for a one-chapter book", () => {
    const source = "Jude 3 urges us to contend for the faith."
    expect(dropped(source, "يحثنا يهوذا 3 على الاجتهاد لأجل الإيمان.")).toEqual([])
    expect(dropped(source, "يحثنا يهوذا ٣ على الاجتهاد لأجل الإيمان.")).toEqual([])
    expect(dropped(source, "يحثنا يهوذا 1: 3 على الاجتهاد لأجل الإيمان.")).toEqual([])
    expect(dropped(source, "يحثنا يهوذا على الاجتهاد لأجل الإيمان.")).toEqual(["Jude 1:3"])
    expect(dropped("Philemon 6 asks for this.", "تطلب فليمون 6 هذا.")).toEqual([])
  })

  it("checks a range by its chapter and first verse", () => {
    const source = '1 Cor. 13:4–7 tells us, "Love is patient, love is kind."'
    expect(dropped(source, "تخبرنا 1 كورنثوس 13: 4–7 قائلة: «المحبة تتأنى وترفق»")).toEqual([])
    expect(dropped(source, "تخبرنا 1 كورنثوس 13 قائلة: «المحبة تتأنى وترفق»")).toEqual(["1 Corinthians 13:4–7"])
    expect(dropped("John 3:16-4:2 is long.", "يوحنا 3: 16 – 4: 2 طويل.")).toEqual([])
  })

  it("checks every passage of a list on its own", () => {
    const source = "Romans 5:8; John 15:13 show us how far his love goes."
    expect(dropped(source, "رومية 5: 8؛ يوحنا 15: 13 تُظهران لنا مدى محبته.")).toEqual([])
    expect(dropped(source, "رومية 5: 8 تُظهر لنا مدى محبته.")).toEqual(["John 15:13"])
    expect(dropped(source, "تُظهران لنا مدى محبته.")).toEqual(["Romans 5:8", "John 15:13"])
    const sameChapter = "John 3:16, 18."
    expect(dropped(sameChapter, "يوحنا 3: 16، 18.")).toEqual([])
    expect(dropped(sameChapter, "يوحنا 3: 16.")).toEqual(["John 3:18"])
  })

  it("names a reference cited twice once", () => {
    expect(dropped("John 3:16 and again John 3:16.", "يوحنا ومرة أخرى يوحنا.")).toEqual(["John 3:16"])
  })

  it("finds nothing for an empty translation, a chapter-only mention, or a source with no reference", () => {
    expect(findDroppedReferences(ISA, "")).toEqual([])
    expect(findDroppedReferences(ISA, "   ")).toEqual([])
    expect(findDroppedReferences("Read Romans 8 this week.", "اقرأ رسالة رومية هذا الأسبوع.")).toEqual([])
    expect(findDroppedReferences("Who is God?", "من هو الله؟")).toEqual([])
    expect(findDroppedReferences("We met 3 times in 2024.", "التقينا ثلاث مرات.")).toEqual([])
  })

  it("uses references the caller already found", () => {
    expect(findDroppedReferences(ISA, "بلا مرجع", { references: [] })).toEqual([])
  })
})
