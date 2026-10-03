import { describe, expect, it } from "vitest"
import {
  MAX_VERSES_PER_REFERENCE,
  findScriptureReferences,
  formatCanonical,
  parseCanonicalRef,
  uniqueReferences,
} from "./reference-finder"

const canon = (text: string) => findScriptureReferences(text).map((f) => f.canonical)

describe("findScriptureReferences (AQU-1573)", () => {
  it("finds full names, abbreviations and dotted abbreviations", () => {
    expect(canon("Isaiah 40:25 says, \"To whom will you compare me?\"")).toEqual(["ISA 40:25"])
    expect(canon("As Is 40:25 puts it")).toEqual(["ISA 40:25"])
    expect(canon("See Isa. 40:25.")).toEqual(["ISA 40:25"])
    expect(canon("1 Cor. 13:4–7 tells us")).toEqual(["1CO 13:4-7"])
    expect(canon("Matt 5:3, Mk 1:15 and Lk 4:18")).toEqual(["MAT 5:3", "MRK 1:15", "LUK 4:18"])
  })

  it("reads ordinals as digits, Roman numerals, words and 1st/2nd/3rd", () => {
    expect(canon("1 John 4:8")).toEqual(["1JN 4:8"])
    expect(canon("1John 4:8")).toEqual(["1JN 4:8"])
    expect(canon("I John 4:8")).toEqual(["1JN 4:8"])
    expect(canon("First John 4:8")).toEqual(["1JN 4:8"])
    expect(canon("1st John 4:8")).toEqual(["1JN 4:8"])
    expect(canon("II Kings 2:11")).toEqual(["2KI 2:11"])
    expect(canon("Second Timothy 3:16")).toEqual(["2TI 3:16"])
    expect(canon("3 John 4")).toEqual(["3JN 1:4"])
  })

  it("never reads 1 John as John", () => {
    const found = findScriptureReferences("Compare 1 John 3:16 with John 3:16.")
    expect(found.map((f) => f.canonical)).toEqual(["1JN 3:16", "JHN 3:16"])
    expect(found[0].start).toBe("Compare ".length)
  })

  it("handles book-name variants", () => {
    expect(canon("Song of Songs 2:4")).toEqual(["SNG 2:4"])
    expect(canon("Song of Solomon 2:4")).toEqual(["SNG 2:4"])
    expect(canon("Canticles 2:4")).toEqual(["SNG 2:4"])
    expect(canon("Psalm 23:1")).toEqual(["PSA 23:1"])
    expect(canon("Psalms 23:1")).toEqual(["PSA 23:1"])
    expect(canon("Ps 23:1")).toEqual(["PSA 23:1"])
    expect(canon("Revelation 3:20 and Revelations 21:4")).toEqual(["REV 3:20", "REV 21:4"])
    expect(canon("Phil 4:13 and Philem 6")).toEqual(["PHP 4:13", "PHM 1:6"])
  })

  it("reads ranges, cross-chapter ranges and dot separators", () => {
    expect(canon("John 3:16-18")).toEqual(["JHN 3:16-18"])
    expect(canon("John 3:16 – 18")).toEqual(["JHN 3:16-18"])
    expect(canon("John 3:16—4:2")).toEqual(["JHN 3:16-4:2"])
    expect(canon("John 3.16")).toEqual(["JHN 3:16"])
    expect(canon("John 3:16 to 18")).toEqual(["JHN 3:16-18"])
    // A same-chapter range written in full (review 2026-10-02).
    expect(canon("John 3:16-3:18")).toEqual(["JHN 3:16-18"])
    expect(canon("John 3:16–3:16")).toEqual(["JHN 3:16"])
  })

  it("reads verse lists and same-book chapter lists as separate passages", () => {
    expect(canon("John 3:16, 18")).toEqual(["JHN 3:16", "JHN 3:18"])
    expect(canon("John 3:16 and 18-20")).toEqual(["JHN 3:16", "JHN 3:18-20"])
    expect(canon("Romans 8:28; 12:1-2")).toEqual(["ROM 8:28", "ROM 12:1-2"])
    expect(canon("Romans 5:8; John 15:13 show us")).toEqual(["ROM 5:8", "JHN 15:13"])
    expect(canon("Romans 8:28, 2 Timothy 3:16")).toEqual(["ROM 8:28", "2TI 3:16"])
    expect(canon("John 3:16, 18 and 20.")).toEqual(["JHN 3:16", "JHN 3:18", "JHN 3:20"])
    expect(canon("(John 3:16, 18)")).toEqual(["JHN 3:16", "JHN 3:18"])
    expect(canon("John 3:16 and verse 18 tell us")).toEqual(["JHN 3:16", "JHN 3:18"])
  })

  it("does not read a count after a reference as another verse (review 2026-10-02)", () => {
    expect(canon("Read Romans 8:28 and 2 more passages")).toEqual(["ROM 8:28"])
    expect(canon("see John 3:16, 17 people came")).toEqual(["JHN 3:16"])
    expect(canon("John 3:16 & 3 friends")).toEqual(["JHN 3:16"])
  })

  it("reads spoken forms", () => {
    expect(canon("John chapter 3, verse 16")).toEqual(["JHN 3:16"])
    expect(canon("John 3 verse 16")).toEqual(["JHN 3:16"])
    expect(canon("John chapter 3 verses 16-18")).toEqual(["JHN 3:16-18"])
    expect(canon("John 3, verses 16 through 18")).toEqual(["JHN 3:16-18"])
  })

  it("drops verse part letters and keeps single-chapter books", () => {
    expect(canon("Romans 8:28a")).toEqual(["ROM 8:28"])
    expect(canon("Jude 3")).toEqual(["JUD 1:3"])
    expect(canon("Jude 1:24-25")).toEqual(["JUD 1:24-25"])
    expect(canon("Obadiah 15")).toEqual(["OBA 1:15"])
  })

  it("ignores chapter-only references, lower-case names and clock times", () => {
    expect(canon("Read Romans 8 this week.")).toEqual([])
    expect(canon("Read John chapter 3 tonight.")).toEqual([])
    expect(canon("we read john 3:16 together")).toEqual([])
    expect(canon("Meet at 5:30.")).toEqual([])
    expect(canon("Is 5:00 ok?")).toEqual([])
    expect(canon("Is 5:30 pm ok?")).toEqual([])
    expect(canon("Is 2.5 hours enough?")).toEqual([])
    expect(canon("Mark 10:45:00 was the time")).toEqual([])
    expect(canon("Isaac 3:4 and Joel's 2:1")).toEqual([])
    expect(canon("Psalm 0:1 and John 3:0")).toEqual([])
  })

  it("labels references for readers and keeps their spans", () => {
    const text = "Read 1 Cor. 13:4–7 and Psalm 23:1."
    const found = findScriptureReferences(text)
    expect(found.map((f) => f.label)).toEqual(["1 Corinthians 13:4–7", "Psalm 23:1"])
    expect(found.map((f) => text.slice(f.start, f.end))).toEqual(["1 Cor. 13:4–7", "Psalm 23:1"])
    expect(findScriptureReferences("Psalms 23:1-24:2")[0].label).toBe("Psalms 23:1–24:2")
  })

  it("caps a long range at 30 verses and marks it truncated", () => {
    const [f] = findScriptureReferences("Psalm 119:1-176")
    expect(f.canonical).toBe(`PSA 119:1-${MAX_VERSES_PER_REFERENCE}`)
    expect(f.truncated).toBe(true)
  })

  it("stops adding references once a text cites 60 verses", () => {
    const text = "Psalm 119:1-30, Psalm 119:31-60, Psalm 119:61-90, John 3:16"
    expect(canon(text)).toEqual(["PSA 119:1-30", "PSA 119:31-60"])
  })

  it("returns repeats but de-duplicates on request", () => {
    const found = findScriptureReferences("John 3:16 … again, John 3:16")
    expect(found).toHaveLength(2)
    expect(uniqueReferences(found).map((f) => f.canonical)).toEqual(["JHN 3:16"])
  })
})

describe("canonical wire form (AQU-1573)", () => {
  it("round-trips", () => {
    for (const c of ["ISA 40:25", "JHN 3:16-18", "JHN 3:16-4:2", "1CO 13:4-7"]) {
      const ref = parseCanonicalRef(c)
      expect(ref).not.toBeNull()
      expect(formatCanonical(ref!)).toBe(c)
    }
  })

  it("rejects malformed or unknown references", () => {
    for (const c of ["", "ISA", "XYZ 1:1", "ISA 40", "ISA 40:0", "ISA 40:5-3", "JHN 4:1-3:2", "isa 40:25"]) {
      expect(parseCanonicalRef(c)).toBeNull()
    }
  })
})
