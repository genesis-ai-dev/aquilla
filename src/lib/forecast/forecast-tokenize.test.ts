// Language-agnostic word segmentation for BIA forecasting: spaceless scripts,
// right-to-left scripts, combining marks, apostrophe-as-letter orthographies,
// and case folding — plus the same behaviour through the engine.

import { afterEach, describe, expect, it } from "vitest"
import { BiaEngine } from "./bia-engine"
import { BiaIndex, type ForecastCell } from "./bia-index"
import { suggestAtCaret } from "./forecast-protocol"
import { fold, graphemes, isSingleWord, joiner, segmentWords, setSegmenterForTests, stripZeroWidth, wordKeys } from "./forecast-tokenize"

afterEach(() => setSegmenterForTests(undefined))

const surfaces = (text: string) => segmentWords(text).map((w) => w.surface)

/** eBible-style text: a ZERO WIDTH SPACE between the syllables of every word. */
const withSyllableZwsp = (text: string) =>
  text.split(" ").map((word) => graphemes(word).join("\u200B")).join(" ")

function engineOf(texts: string[], sources: string[] = []): BiaEngine {
  const index = new BiaIndex()
  index.upsert(texts.map((text, i): ForecastCell => ({ id: `c${i}`, text, source: sources[i], validated: true, order: i })))
  return new BiaEngine(index)
}

describe("segmentWords", () => {
  it("splits Thai, which has no spaces between words, into words", () => {
    const words = surfaces("ในเริ่มแรกนั้นพระเจ้าทรงสร้างฟ้าและแผ่นดินโลก")
    expect(words.length).toBeGreaterThan(5)
    expect(words).toContain("พระเจ้า")
    expect(words.join("")).toBe("ในเริ่มแรกนั้นพระเจ้าทรงสร้างฟ้าและแผ่นดินโลก")
  })

  it("splits Chinese into words and drops CJK punctuation", () => {
    const words = surfaces("本书为亚伯拉罕和大卫的后代弥赛亚的记录。")
    expect(words.length).toBeGreaterThan(5)
    expect(words).not.toContain("。")
    expect(words.join("")).toBe("本书为亚伯拉罕和大卫的后代弥赛亚的记录")
  })

  it("keeps Arabic and Hebrew words whole with their vowel marks, in logical order", () => {
    expect(surfaces("فِي الْبَدْءِ خَلَقَ اللهُ")).toEqual(["فِي", "الْبَدْءِ", "خَلَقَ", "اللهُ"])
    expect(surfaces("בְּרֵאשִׁית בָּרָא אֱלֹהִים")).toEqual(["בְּרֵאשִׁית", "בָּרָא", "אֱלֹהִים"])
  })

  it("NFC-normalises, so decomposed and precomposed spellings are one word", () => {
    const composed = "\u0958\u0932\u092E" // क़ as one code point (U+0958)
    const decomposed = "\u0915\u093C\u0932\u092E" // क + nukta
    expect(composed).not.toBe(decomposed)
    expect(wordKeys(decomposed)).toEqual(wordKeys(composed))
    expect(wordKeys("Jesús")).toEqual(wordKeys("Jesús"))
  })

  it("keeps Devanagari vowel signs and viramas inside the word", () => {
    expect(surfaces("परमप्रभुको भय छाउनेछ ।")).toEqual(["परमप्रभुको", "भय", "छाउनेछ"])
    // A grapheme is a consonant with its signs, not a code point.
    expect(graphemes("प्रभु").length).toBeLessThan(Array.from("प्रभु").length)
  })

  it("keeps the zero-width joiner inside Devanagari conjuncts, and drops a stray one", () => {
    // Nepali writes त्‍यसको with virama + ZWJ; splitting there made two
    // easy-to-predict fragments out of one word.
    expect(surfaces("त्‍यसको नाम")).toEqual(["त्‍यसको", "नाम"])
    expect(surfaces("रहेको ‍एल")).toEqual(["रहेको", "‍एल"].slice(0, 1).concat(surfaces("‍एल")))
    expect(surfaces("नजिक ‍ गरे")).toEqual(["नजिक", "गरे"])
  })

  it("keeps the zero-width non-joiner inside Persian words", () => {
    expect(surfaces("می‌خواهم بروم")).toEqual(["می‌خواهم", "بروم"])
  })

  it("segments Burmese the same whether or not its syllables carry a ZERO WIDTH SPACE", () => {
    // eBible's Burmese puts U+200B between every syllable and ICU breaks there,
    // so every method used to see syllables instead of dictionary words.
    const plain = "ဘုရားသခင်သည် မိုးကောင်းကင်ကို ဖန်ဆင်းတော်မူ၏"
    const zwsp = withSyllableZwsp(plain)
    expect(zwsp).not.toBe(plain)
    expect(stripZeroWidth(zwsp)).toBe(plain)
    expect(surfaces(plain)).toContain("ဘုရားသခင်")
    expect(surfaces(zwsp)).toEqual(surfaces(plain))
    expect(wordKeys(zwsp)).toEqual(wordKeys(plain))
  })

  it("keeps offsets pointing into the original text when zero-width spaces are dropped", () => {
    const text = withSyllableZwsp("ဘုရားသခင်သည် မိုးကောင်းကင်ကို")
    for (const word of segmentWords(text)) {
      expect(stripZeroWidth(text.slice(word.start, word.end))).toBe(word.surface)
    }
    // A caret after a trailing zero-width space is still inside the last word.
    const trailing = "ကောင်း\u200B"
    expect(segmentWords(trailing).at(-1)?.end).toBe(trailing.length)
  })

  it("drops the word joiner and the BOM from word keys, and joins across them", () => {
    expect(wordKeys("ab\uFEFFc")).toEqual(["abc"])
    expect(wordKeys("ab\u2060c")).toEqual(["abc"])
    expect(surfaces("one\u200Btwo three")).toEqual(["onetwo", "three"])
    expect(isSingleWord("one\u200Btwo")).toBe(true)
  })

  it("treats a straight apostrophe as a letter (glottal stop), a typographic quote as punctuation", () => {
    expect(surfaces("xuquje' ri b'i' are'.")).toEqual(["xuquje'", "ri", "b'i'", "are'"])
    expect(surfaces("God’s ‘light’")).toEqual(["God’s", "light"])
  })

  it("case-folds locale-independently, including Greek final sigma", () => {
    expect(fold("ΟΔΟΣ")).toBe(fold("οδοσ"))
    expect(fold("οδος")).toBe("οδοσ")
    expect(fold("İstanbul")).toBe("i̇stanbul") // Unicode default, not Turkish rules
    expect(fold("พระเจ้า")).toBe("พระเจ้า")
  })

  it("falls back to Unicode categories without Intl.Segmenter", () => {
    setSegmenterForTests(null)
    expect(surfaces("Are wa' ri b'i' xuquje'")).toEqual(["Are", "wa'", "ri", "b'i'", "xuquje'"])
    expect(surfaces("बिचमा परमप्रभुको")).toEqual(["बिचमा", "परमप्रभुको"])
  })

  it("isSingleWord and joiner know which scripts use spaces", () => {
    expect(isSingleWord("พระเจ้า")).toBe(true)
    expect(isSingleWord("พระเจ้าทรง")).toBe(false)
    expect(isSingleWord("b'i'")).toBe(true)
    expect(joiner("พระเจ้า", "ทรง")).toBe("")
    expect(joiner("大卫", "的")).toBe("")
    expect(joiner("God", "said")).toBe(" ")
  })
})

describe("the engine in other scripts", () => {
  it("suggests the next Thai word right after a complete word, with no space", () => {
    const engine = engineOf(["พระเจ้าทรงสร้างฟ้า", "พระเจ้าทรงสร้างแผ่นดิน", "พระเจ้าทรงสร้างฟ้า"])
    const [first] = suggestAtCaret(engine, "พระเจ้าทรง")
    expect(first.word).toBe("สร้าง")
    expect(first.insert.startsWith("สร้าง")).toBe(true) // no leading space
    expect(first.insert).not.toContain(" ")
  })

  it("suggests the next Chinese word", () => {
    const engine = engineOf(["大卫的后代", "亚伯拉罕的后代", "大卫的子孙"])
    expect(suggestAtCaret(engine, "亚伯拉罕的")[0]?.word).toBe("后代")
  })

  it("completes an Arabic word and suggests the next one", () => {
    const engine = engineOf(["فِي الْبَدْءِ خَلَقَ اللهُ", "فِي الْبَدْءِ كَانَ الْكَلِمَةُ", "خَلَقَ اللهُ السَّمَاوَاتِ"])
    expect(suggestAtCaret(engine, "فِي ")[0]?.word).toBe("الْبَدْءِ")
    expect(suggestAtCaret(engine, "خَلَقَ ال")[0]?.insert.startsWith("لهُ")).toBe(true)
  })

  it("matches decomposed Devanagari typing against the precomposed corpus", () => {
    const corpus = "\u0958\u0932\u092E \u0938\u0947 \u0932\u093F\u0916\u094B" // precomposed क़
    const engine = engineOf([corpus, corpus, "हाथ से लिखो"])
    expect(suggestAtCaret(engine, "\u0915\u093C\u0932\u092E ")[0]?.word).toBe("से")
  })

  it("learns a Hebrew target's lexicon from an English source", () => {
    const engine = engineOf(
      ["בָּרָא אֱלֹהִים אוֹר", "בָּרָא אֱלֹהִים מַיִם", "רָאָה אֱלֹהִים אוֹר"],
      ["God created light", "God created water", "God saw light"],
    )
    expect(engine.index.lexicon.dice("light", "אוֹר")).toBeGreaterThan(0.9)
    const [first] = engine.suggestNext("בָּרָא אֱלֹהִים ", { extend: false, source: "God created water" })
    expect(first.word).toBe("מַיִם")
  })

  it("suggests a whole Burmese word from a corpus whose syllables carry U+200B", () => {
    // eBible-style Burmese: every syllable separated by a ZERO WIDTH SPACE.
    const verse = "ဘုရားသခင်သည် မိုးကောင်းကင်ကို ဖန်ဆင်းတော်မူ၏"
    const engine = engineOf([verse, verse, "ဘုရားသခင်သည် ကောင်း၏"].map(withSyllableZwsp))
    const [first] = suggestAtCaret(engine, "ဘုရားသခင်သည် ")
    // The dictionary word, not its first syllable (မိုး), and no U+200B in it.
    expect(first.word).toBe("မိုးကောင်းကင်")
    expect(first.word).not.toContain("\u200B")
  })

  it("completes a K'iche' word ending in a glottal-stop apostrophe", () => {
    const engine = engineOf(["xuquje' ri are'", "xuquje' ri Jesús", "ri are' xuquje'"])
    expect(suggestAtCaret(engine, "xuquj")[0]?.insert.startsWith("e'")).toBe(true)
  })
})
