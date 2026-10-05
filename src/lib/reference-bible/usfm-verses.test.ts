import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { extractUsfmVerses } from "./usfm-verses"

// Real eBible.org chapters (ISA 40, PSA 23 + 51, JHN 3, ROM 8, 1CO 13),
// copied verbatim from arb-vd and eng-kjv2006 so the extractor is tested
// against the markup it actually meets.
const fixture = (name: string) => readFileSync(path.join(__dirname, "__fixtures__", name), "utf8")
// Compared in NFC: eBible stores shadda before the short vowel, and editors
// tend to reorder combining marks into canonical order on save.
const byRef = (usfm: string) =>
  new Map(extractUsfmVerses(usfm).map((r) => [`${r.book} ${r.chapter}:${r.verse}`, r.text.normalize("NFC")]))

describe("extractUsfmVerses (AQU-1573)", () => {
  const arb = byRef(fixture("arb-vd-sample.usfm"))
  const kjv = byRef(fixture("eng-kjv-sample.usfm"))

  it("reads every verse of every book in the file", () => {
    expect(arb.size).toBe(144)
    expect(kjv.size).toBe(144)
    expect([...arb.keys()].slice(0, 2)).toEqual(["ISA 40:1", "ISA 40:2"])
  })

  it("keeps the vowelled Van Dyck text exactly", () => {
    expect(arb.get("ISA 40:25")).toBe("«فَبِمَنْ تُشَبِّهُونَنِي فَأُسَاوِيَهُ؟» يَقُولُ ٱلْقُدُّوسُ.")
    expect(arb.get("JHN 3:16")).toBe(
      "لِأَنَّهُ هَكَذَا أَحَبَّ ٱللهُ ٱلْعَالَمَ حَتَّى بَذَلَ ٱبْنَهُ ٱلْوَحِيدَ، لِكَيْ لَا يَهْلِكَ كُلُّ مَنْ يُؤْمِنُ بِهِ، بَلْ تَكُونُ لَهُ ٱلْحَيَاةُ ٱلْأَبَدِيَّةُ.",
    )
  })

  it("drops psalm titles and section headings instead of merging them into verse 1", () => {
    expect(arb.get("PSA 51:1")).toBe("اِرْحَمْنِي يَا ٱللهُ حَسَبَ رَحْمَتِكَ. حَسَبَ كَثْرَةِ رَأْفَتِكَ ٱمْحُ مَعَاصِيَّ.")
    expect(kjv.get("PSA 51:1")).toMatch(/^Have mercy upon me, O God/)
    expect(kjv.get("PSA 23:1")).toBe("The LORD is my shepherd; I shall not want.")
    expect(arb.get("ISA 40:1")).not.toMatch(/\\/)
  })

  it("unwraps Strong's tags, \\+w, \\add and \\nd but keeps their words", () => {
    expect(kjv.get("ISA 40:25")).toBe("To whom then will ye liken me, or shall I be equal? saith the Holy One.")
    expect(kjv.get("JHN 3:16")).toBe(
      "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.",
    )
    expect(kjv.get("ROM 8:28")).toBe(
      "And we know that all things work together for good to them that love God, to them who are the called according to his purpose.",
    )
  })

  it("drops footnotes, pilcrows and every marker", () => {
    for (const text of [...arb.values(), ...kjv.values()]) {
      expect(text).not.toMatch(/[\\¶|]|strong=/)
      expect(text).toBe(text.trim())
      expect(text).not.toMatch(/\s{2}/)
    }
  })

  it("keeps a supplied word glued to the word before it and punctuation after a tag", () => {
    const usfm = "\\id GEN\n\\c 1\n\\p\n\\v 1 the \\w earth|strong=\"H0776\"\\w*. Word\\add s\\add* end.\n\\q1 next line \\f + \\fr 1.1 \\ft note\\f* done\n\\v 2 two"
    expect(extractUsfmVerses(usfm)).toEqual([
      { book: "GEN", chapter: 1, verse: 1, text: "the earth. Words end. next line done" },
      { book: "GEN", chapter: 1, verse: 2, text: "two" },
    ])
  })

  it("returns nothing without a book id", () => {
    expect(extractUsfmVerses("\\c 1\n\\v 1 text")).toEqual([])
  })
})
