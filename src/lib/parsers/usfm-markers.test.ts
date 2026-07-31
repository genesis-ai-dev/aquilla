import { describe, it, expect } from "vitest"
import {
  classifyMarker,
  normalizeMarker,
  terminatesVerse,
  isTranslatable,
  isEndMarker,
  isNestedMarker,
  isBookTitleOrIntroMarker,
} from "./usfm-markers"

describe("normalizeMarker", () => {
  it("strips the backslash", () => {
    expect(normalizeMarker("\\nd")).toBe("nd")
  })
  it("strips the nested + prefix", () => {
    expect(normalizeMarker("\\+xt")).toBe("xt")
    expect(normalizeMarker("+wj")).toBe("wj")
  })
  it("strips the end-marker *", () => {
    expect(normalizeMarker("\\nd*")).toBe("nd")
    expect(normalizeMarker("\\+xt*")).toBe("xt")
  })
  it("strips numbered level variants to the family base", () => {
    expect(normalizeMarker("s1")).toBe("s")
    expect(normalizeMarker("q2")).toBe("q")
    expect(normalizeMarker("mt3")).toBe("mt")
    expect(normalizeMarker("li4")).toBe("li")
    expect(normalizeMarker("io2")).toBe("io")
    expect(normalizeMarker("imt1")).toBe("imt")
  })
  it("keeps toc1/toc2/toc3 mapping to the toc family", () => {
    expect(normalizeMarker("toc1")).toBe("toc")
    expect(normalizeMarker("toc3")).toBe("toc")
  })
})

describe("classifyMarker", () => {
  it("classifies verse as translatable + structural", () => {
    const v = classifyMarker("\\v")!
    expect(v.category).toBe("verse")
    expect(v.translatable).toBe(true)
    expect(v.structural).toBe(true)
  })
  it("classifies footnote text \\ft as translatable, non-structural", () => {
    const ft = classifyMarker("\\ft")!
    expect(ft.translatable).toBe(true)
    expect(ft.structural).toBe(false)
    expect(ft.category).toBe("note")
  })
  it("classifies footnote ref \\fr as NON-translatable (it's a verse ref)", () => {
    expect(classifyMarker("\\fr")!.translatable).toBe(false)
  })
  it("classifies xref origin \\xo as NON-translatable", () => {
    expect(classifyMarker("\\xo")!.translatable).toBe(false)
  })
  it("classifies Selah \\qs as translatable", () => {
    expect(classifyMarker("\\qs")!.role).toBe("selah")
    expect(classifyMarker("\\qs")!.translatable).toBe(true)
  })
  it("classifies divine name \\nd and \\+nd identically", () => {
    expect(classifyMarker("\\nd")!.role).toBe("divine-name")
    expect(classifyMarker("\\+nd")!.role).toBe("divine-name")
    expect(classifyMarker("\\+nd*")!.role).toBe("divine-name")
  })
  it("classifies descriptive title \\d (Psalms) as translatable heading", () => {
    expect(classifyMarker("\\d")!.translatable).toBe(true)
    expect(classifyMarker("\\d")!.category).toBe("heading")
  })
  it("classifies published verse \\vp as translatable, non-structural", () => {
    const vp = classifyMarker("\\vp")!
    expect(vp.translatable).toBe(true)
    expect(vp.structural).toBe(false)
  })
  it("returns undefined for a genuinely unknown marker", () => {
    expect(classifyMarker("\\zznotreal")).toBeUndefined()
  })
})

describe("terminatesVerse", () => {
  it("true for verse, chapter, section headings, titles, intros", () => {
    for (const m of ["\\v", "\\c", "\\s", "\\s2", "\\ms", "\\mr", "\\r", "\\d", "\\sp", "\\mt", "\\mt1", "\\h", "\\toc1", "\\ip", "\\io1", "\\id"]) {
      expect(terminatesVerse(m)).toBe(true)
    }
  })
  it("false for paragraph/poetry/list/table markers (they flow WITHIN a verse)", () => {
    for (const m of ["\\p", "\\m", "\\q1", "\\q2", "\\li1", "\\pi", "\\nb", "\\b", "\\tr", "\\qm1"]) {
      expect(terminatesVerse(m)).toBe(false)
    }
  })
  it("false for inline char, notes, refs, end markers, nested", () => {
    for (const m of ["\\nd", "\\wj", "\\f", "\\ft", "\\fr", "\\x", "\\xt", "\\+xt", "\\nd*", "\\qs", "\\add"]) {
      expect(terminatesVerse(m)).toBe(false)
    }
  })
})

describe("isTranslatable", () => {
  it("true for content markers", () => {
    for (const m of ["\\v", "\\ft", "\\fq", "\\fqa", "\\qt", "\\bk", "\\tl", "\\nd", "\\wj", "\\d", "\\s", "\\qs", "\\vp", "\\litl"]) {
      expect(isTranslatable(m)).toBe(true)
    }
  })
  it("false for refs/numbers/scaffolding", () => {
    for (const m of ["\\fr", "\\xo", "\\c", "\\id", "\\ide", "\\fv", "\\p", "\\b"]) {
      expect(isTranslatable(m)).toBe(false)
    }
  })
})

describe("isBookTitleOrIntroMarker (AQU-634 front-matter classifier)", () => {
  it("true for book name / running header / TOC (identification)", () => {
    for (const m of ["\\h", "\\h1", "\\toc1", "\\toc2", "\\toc3", "\\toca1"]) {
      expect(isBookTitleOrIntroMarker(m)).toBe(true)
    }
  })
  it("true for the main title (title category)", () => {
    for (const m of ["\\mt", "\\mt1", "\\mt2", "\\mte", "\\mte1"]) {
      expect(isBookTitleOrIntroMarker(m)).toBe(true)
    }
  })
  it("true for the whole introduction block (introduction category)", () => {
    for (const m of ["\\imt", "\\imt1", "\\is", "\\is1", "\\ip", "\\ipi", "\\ipq", "\\io", "\\io1", "\\io2", "\\iot", "\\im", "\\iq1"]) {
      expect(isBookTitleOrIntroMarker(m)).toBe(true)
    }
  })
  it("false for in-body section headings (they always import)", () => {
    for (const m of ["\\s", "\\s1", "\\s2", "\\ms", "\\ms1", "\\sr", "\\mr", "\\r"]) {
      expect(isBookTitleOrIntroMarker(m)).toBe(false)
    }
  })
  it("false for Psalm descriptive titles \\d and verse/chapter/paragraph markers", () => {
    for (const m of ["\\d", "\\v", "\\c", "\\p", "\\q1", "\\nd", "\\ft"]) {
      expect(isBookTitleOrIntroMarker(m)).toBe(false)
    }
  })
  it("false for an unknown marker (conservative: keep, don't drop)", () => {
    expect(isBookTitleOrIntroMarker("\\zznotreal")).toBe(false)
  })
})

describe("isEndMarker / isNestedMarker", () => {
  it("detects end markers", () => {
    expect(isEndMarker("\\nd*")).toBe(true)
    expect(isEndMarker("\\nd")).toBe(false)
  })
  it("detects nested markers", () => {
    expect(isNestedMarker("\\+xt")).toBe(true)
    expect(isNestedMarker("\\xt")).toBe(false)
  })
})

describe("usfm.sty full coverage (FRO follow-up: footnote/display thoroughness)", () => {
  it("classifies every marker base present in the official usfm.sty", () => {
    // Unique bases from github.com/ubsicap/usfm/blob/master/sty/usfm.sty
    // (numbered variants collapsed: thc1-10→thc, q1-4→q, …).
    const styBases = `add addpn b bd bdit bk c ca cd cl cls conc cov cp d dc em f
      fdc fe fig fk fl fm fp fq fqa fr fs ft fv fw glo h ib id ide idx ie iex ili
      im imi imq imt imte intro io ior iot ip ipi ipq ipr iq iqt is it jmp k lf lh
      li lik lim lit litl liv m maps mi mr ms mt mte nb nd ndx no ord p pb pc
      periph ph phi pi pm pmc pmo pmr pn png po pr pref pro ps psi pub pubinfo q
      qa qac qc qd qm qr qs qt r rb rem restore rq s sc sd sig sls sp spine sr sts
      sup tc tcc tcr th thc thr tl toc toca tr usfm v va vp w wa wg wh wj wr x xdc
      xk xnt xo xop xot xq xt xtSee xtSeeAlso xta zpa-d zpa-xb zpa-xc zpa-xv`
      .split(/\s+/).filter(Boolean)
    const missing = styBases.filter((m) => classifyMarker(m) === undefined)
    expect(missing).toEqual([])
  })

  it("normalizes numbered/mixed-case/hyphenated sty variants", () => {
    expect(classifyMarker("thc10")?.role).toBe("table-head-centered")
    expect(classifyMarker("tcc4")?.role).toBe("table-cell-centered")
    expect(classifyMarker("xtSee*")?.category).toBe("crossref")
    expect(classifyMarker("zpa-xb")?.category).toBe("extension")
  })

  it("peripheral and deprecated paragraph markers never terminate a verse (behavior-preserving)", () => {
    for (const m of ["\\periph", "\\conc", "\\glo", "\\intro", "\\pub", "\\pb", "\\ps", "\\psi", "\\phi", "\\restore"]) {
      expect(terminatesVerse(m)).toBe(false)
    }
  })
})
