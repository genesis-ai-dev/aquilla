import { describe, it, expect } from "vitest"
import { runCheck } from "./number-integrity"

describe("number-integrity", () => {
  it("returns null when all source numbers appear in target", () => {
    expect(runCheck("12 hours, 3 minutes", "12 heures, 3 minutes")).toBeNull()
  })

  it("tolerates locale separators (1,000 vs 1.000)", () => {
    expect(runCheck("Population: 1,000,000", "Población: 1.000.000")).toBeNull()
  })

  it("flags missing number", () => {
    const spans = runCheck("3 days, 12 hours", "trois jours")
    expect(spans).not.toBeNull()
    expect(spans!.some(s => s.matchedText === "12")).toBe(true)
  })

  it("returns null when source has no numbers", () => {
    expect(runCheck("Hello world", "Bonjour")).toBeNull()
  })

  it("matches negative numbers", () => {
    expect(runCheck("Drop of -5 degrees", "Caída de -5 grados")).toBeNull()
    expect(runCheck("Drop of -5 degrees", "Caída de 5 grados")).not.toBeNull()
  })

  it("does not double-count duplicates", () => {
    expect(runCheck("5 and 5", "cinco y 5")).toBeNull()
  })
})

// AQU-1667: Arabic, Persian and Urdu translations write numbers in native
// digits. Before this, `\d` only saw 0–9, so "إشعياء ٤٠:٢٥" reported the
// source's "40" and "25" as missing even though both are there.
describe("number-integrity — native digits (AQU-1667)", () => {
  const source = "Isaiah 40:25"

  it("Western digits in the translation still match", () => {
    expect(runCheck(source, "Isaías 40:25")).toBeNull()
  })

  it("accepts Arabic-Indic digits (٠–٩)", () => {
    expect(runCheck(source, "إشعياء ٤٠:٢٥")).toBeNull()
  })

  it("accepts Eastern Arabic-Indic / Persian digits (۰–۹)", () => {
    expect(runCheck(source, "اشعیا ۴۰:۲۵")).toBeNull()
  })

  it("accepts mixed forms: Western and native numbers side by side", () => {
    expect(runCheck(source, "إشعياء 40:٢٥")).toBeNull()
    expect(runCheck(source, "اشعیا ٤٠:۲۵")).toBeNull()
  })

  it("accepts Arabic-Indic and Persian digits mixed inside one number", () => {
    // Urdu keyboards commonly yield Persian ۴ next to Arabic-Indic ٠.
    expect(runCheck(source, "یسعیاہ ۴٠:٢۵")).toBeNull()
  })

  it("matches the other way round: native digits in the source, Western in the translation", () => {
    expect(runCheck("إشعياء ٤٠:٢٥", "Isaiah 40:25")).toBeNull()
    expect(runCheck("اشعیا ۴۰:۲۵", "Isaiah 40:25")).toBeNull()
  })

  it("still warns when the number differs: ٤١ is not 40", () => {
    const spans = runCheck(source, "إشعياء ٤١:٢٥")
    expect(spans).toEqual([{ side: "source", start: 7, end: 9, matchedText: "40" }])
    expect(runCheck(source, "اشعیا ۴۱:۲۵")).toEqual([
      { side: "source", start: 7, end: 9, matchedText: "40" },
    ])
  })

  it("still warns when the number is genuinely missing", () => {
    expect(runCheck(source, "إشعياء الأربعون")).toEqual([
      { side: "source", start: 7, end: 9, matchedText: "40" },
      { side: "source", start: 10, end: 12, matchedText: "25" },
    ])
  })

  it("underlines native digits in the source at their own position, as typed", () => {
    // "إشعياء " is 7 UTF-16 units, so "٤٠" sits at 7–9 and "٢٥" at 10–12.
    expect(runCheck("إشعياء ٤٠:٢٥", "Isaiah 40:26")).toEqual([
      { side: "source", start: 10, end: 12, matchedText: "٢٥" },
    ])
  })

  it("decimals: ٫ (U+066B) and '.' both work with native digits", () => {
    expect(runCheck("Add 3.5 kg", "أضف ٣٫٥ كغ")).toBeNull()
    expect(runCheck("Add 3.5 kg", "أضف ٣.٥ كغ")).toBeNull()
    expect(runCheck("Add 3.5 kg", "اضافه کنید ۳٫۵ کیلوگرم")).toBeNull()
    expect(runCheck("Add 3.5 kg", "أضف ٣٫٦ كغ")).not.toBeNull()
  })

  it("thousands: ٬ (U+066C), ',' and '.' all work with native digits", () => {
    expect(runCheck("Population: 1,000,000", "السكان: ١٬٠٠٠٬٠٠٠")).toBeNull()
    expect(runCheck("Population: 1,000,000", "السكان: ١,٠٠٠,٠٠٠")).toBeNull()
    expect(runCheck("Population: 1,000,000", "جمعیت: ۱٬۰۰۰٬۰۰۰")).toBeNull()
    expect(runCheck("Population: 1,000,000", "السكان: ١٬٠٠٠٬٠٠١")).not.toBeNull()
  })

  it("Western digits with the Arabic separators count as one number", () => {
    expect(runCheck("Add 3.5 kg", "أضف 3٫5 كغ")).toBeNull()
    expect(runCheck("Population: 1,000,000", "السكان: 1٬000٬000")).toBeNull()
  })

  it("the Arabic comma ، is a list separator, not part of a number", () => {
    expect(runCheck("Chapters 3 and 4", "الفصلان ٣،٤")).toBeNull()
    expect(runCheck("Chapter 34", "الفصلان ٣،٤")).not.toBeNull()
  })

  it("signs: a leading minus still has to survive", () => {
    expect(runCheck("Drop of -5 degrees", "انخفاض -٥ درجات")).toBeNull()
    expect(runCheck("Drop of -5 degrees", "انخفاض ٥ درجات")).not.toBeNull()
  })

  it("ranges behave exactly as they do with Western digits", () => {
    expect(runCheck("verses 3-5", "الآيات ٣-٥")).toBeNull()
    expect(runCheck("verses 3-5", "آیات ۳-۵")).toBeNull()
    expect(runCheck("verses 3-5", "الآيات ٣-٦")).not.toBeNull()
  })
})

// Sam, Oct 7: "as many scripts covered as possible", with no list to keep up.
// Any Unicode decimal digit counts, valued by its place in its script's run.
describe("number-integrity — any script's decimal digits (AQU-1667)", () => {
  const SOURCE = "He fasted 40 days and 40 nights."

  it.each([
    ["Burmese", "၄၀"],
    ["Thai", "๔๐"],
    ["Devanagari", "४०"],
    ["Bengali", "৪০"],
    ["Khmer", "៤០"],
    ["Tibetan", "༤༠"],
    ["fullwidth", "４０"],
  ])("accepts %s digits", (_script, forty) => {
    expect(runCheck(SOURCE, `${forty} … ${forty}`)).toBeNull()
  })

  it("accepts digits outside the BMP (Adlam 𞥔𞥐 is 40)", () => {
    expect(runCheck(SOURCE, "𞥔𞥐 … 𞥔𞥐")).toBeNull()
  })

  it("values digits in back-to-back runs correctly (mathematical bold and double-struck)", () => {
    // U+1D7CE–1D7FF holds five styles of 0–9 in a row.
    expect(runCheck("40", "𝟒𝟎")).toBeNull()
    expect(runCheck("40", "𝟜𝟘")).toBeNull()
    // A double-struck 4 next to a bold 9 (U+1D7D7) is still 49.
    expect(runCheck("49", "𝟜𝟗")).toBeNull()
    expect(runCheck("41", "𝟜𝟘")).not.toBeNull()
  })

  it("still warns when the number differs: Burmese ၄၁ is not 40", () => {
    expect(runCheck("40 days", "၄၁ ရက်")).toEqual([
      { side: "source", start: 0, end: 2, matchedText: "40" },
    ])
  })

  it("underlines a source number written outside the BMP at its own position", () => {
    // Each Adlam digit is two UTF-16 units, so "𞥔𞥐" spans 0–4.
    expect(runCheck("𞥔𞥐 days", "no number")).toEqual([
      { side: "source", start: 0, end: 4, matchedText: "𞥔𞥐" },
    ])
  })

  it("does not read numerals that are not decimal digits (Ethiopic ፵, Roman, CJK 四十)", () => {
    // Unicode files these as letters or other numbers, not as digits 0–9, so
    // they need their own reading; the number still counts as missing.
    expect(runCheck("40", "፵")).not.toBeNull()
    expect(runCheck("40", "四十")).not.toBeNull()
  })
})

// Western-digit projects must see no change at all. The pre-AQU-1667 check is
// reproduced verbatim below and both are run over the same Western inputs.
describe("number-integrity — Western digits unchanged (AQU-1667)", () => {
  const LEGACY_RE = /-?\d+(?:[.,]\d+)*/g
  const legacyCanon = (raw: string) =>
    raw.startsWith("-") ? "-" + raw.slice(1).replace(/[^0-9]/g, "") : raw.replace(/[^0-9]/g, "")
  function legacyRunCheck(source: string, target: string) {
    const sourceMatches = [...source.matchAll(LEGACY_RE)]
    if (sourceMatches.length === 0) return null
    const targetCanonical = new Set([...target.matchAll(LEGACY_RE)].map((m) => legacyCanon(m[0])))
    const missing = sourceMatches
      .filter((m) => !targetCanonical.has(legacyCanon(m[0])))
      .map((m) => ({ side: "source", start: m.index!, end: m.index! + m[0].length, matchedText: m[0] }))
    return missing.length > 0 ? missing : null
  }

  const pairs: [string, string][] = [
    ["Isaiah 40:25", "Isaías 40:25"],
    ["Isaiah 40:25", "Isaías 40:26"],
    ["Isaiah 40:25", "Isaías cuarenta"],
    ["12 hours, 3 minutes", "12 heures, 3 minutes"],
    ["Population: 1,000,000", "Población: 1.000.000"],
    ["Population: 1,000,000", "Población: 1 000 000"],
    ["Add 3.5 kg", "Ajouter 3,5 kg"],
    ["Add 3.5 kg", "Ajouter 35 kg"],
    ["Drop of -5 degrees", "Caída de -5 grados"],
    ["Drop of -5 degrees", "Caída de 5 grados"],
    ["verses 3-5", "versículos 3-5"],
    ["verses 3-5", "versículos 3–5"],
    ["5 and 5", "cinco y 5"],
    ["v1.2.3 build 0042", "v1.2.3 compilación 42"],
    ["No numbers here", "Aucun nombre"],
    ["Matthew 5:3-12; 6:1", "Mateo 5:3-12; 6:2"],
  ]

  it.each(pairs)("%s → %s gives the same result as before", (source, target) => {
    expect(runCheck(source, target)).toEqual(legacyRunCheck(source, target))
  })
})
