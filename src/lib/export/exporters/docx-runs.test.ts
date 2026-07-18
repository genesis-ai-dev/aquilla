import { describe, it, expect } from "vitest"
import { htmlToSpans, spansToRuns, spansToRunXml } from "./docx-runs"

describe("htmlToSpans", () => {
  it("plain text → one markless span", () => {
    expect(htmlToSpans("hello world")).toEqual([{ text: "hello world", marks: new Set() }])
  })
  it("bold word → three spans, middle bold", () => {
    const spans = htmlToSpans("the <strong>Lord</strong> said")
    expect(spans.map(s => s.text)).toEqual(["the ", "Lord", " said"])
    expect([...spans[1].marks]).toEqual(["b"])
    expect(spans[0].marks.size).toBe(0)
  })
  it("nested italic+bold → both marks", () => {
    const spans = htmlToSpans("<em><strong>x</strong></em>")
    expect([...spans[0].marks].sort()).toEqual(["b", "i"])
  })
  it("empty/whitespace → []", () => {
    expect(htmlToSpans("")).toEqual([])
    expect(htmlToSpans("   ")).toEqual([])
  })
  it("mixed leading-text, element, trailing-text → three spans with correct marks", () => {
    const spans = htmlToSpans("a<b>B</b>c")
    expect(spans.map(s => s.text)).toEqual(["a", "B", "c"])
    expect(spans[0].marks.size).toBe(0)
    expect([...spans[1].marks]).toEqual(["b"])
    expect(spans[2].marks.size).toBe(0)
  })
})

describe("spansToRunXml", () => {
  it("builds clean run XML with no xmlns pollution", () => {
    const xml = spansToRunXml(htmlToSpans("a<strong>B</strong>"), null)
    expect(xml).not.toMatch(/xmlns/) // critical: no namespace decls in spliced fragment
    expect(xml).toMatch(/<w:r><w:t xml:space="preserve">a<\/w:t><\/w:r>/)
    expect(xml).toMatch(/<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">B<\/w:t><\/w:r>/)
  })

  it("splices translator toggles into a cloned baseRpr", () => {
    const xml = spansToRunXml(htmlToSpans("<em>x</em>"), '<w:rPr><w:sz w:val="24"/></w:rPr>')
    // base font size kept AND italic added
    expect(xml).toContain('<w:sz w:val="24"/>')
    expect(xml).toContain("<w:i/>")
  })

  it("escapes XML special chars in text", () => {
    expect(spansToRunXml(htmlToSpans("a & b < c"), null)).toContain("a &amp; b &lt; c")
  })

  it("emits no rPr when no toggles and no base", () => {
    const xml = spansToRunXml([{ text: "plain", marks: new Set() }], null)
    expect(xml).toBe('<w:r><w:t xml:space="preserve">plain</w:t></w:r>')
  })

  it("handles self-closed baseRpr (<w:rPr/>) by expanding it with toggles", () => {
    const xml = spansToRunXml(htmlToSpans("<strong>x</strong>"), "<w:rPr/>")
    expect(xml).toContain("<w:rPr><w:b/></w:rPr>")
  })
})

describe("spansToRuns", () => {
  it("emits one w:r per span with bold toggle", () => {
    const doc = new DOMParser().parseFromString("<root/>", "application/xml")
    const runs = spansToRuns(doc, htmlToSpans("a <b>b</b>"), null)
    expect(runs.length).toBe(2)
    expect(runs[1].getElementsByTagName("w:b").length).toBe(1)
    expect(runs[0].getElementsByTagName("w:b").length).toBe(0)
    expect(runs[1].getElementsByTagName("w:t")[0].textContent).toBe("b")
  })
  it("appends rPr even when baseRpr has zero children (baseRpr inheritance not dropped)", () => {
    const xmlDoc = new DOMParser().parseFromString("<root/>", "application/xml")
    const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    const emptyRpr = xmlDoc.createElementNS(W_NS, "w:rPr")
    const runs = spansToRuns(xmlDoc, [{ text: "x", marks: new Set() }], emptyRpr)
    expect(runs.length).toBe(1)
    // run should have two children: rPr (baseRpr clone) + w:t
    const children = Array.from(runs[0].childNodes)
    expect(children.length).toBe(2)
    expect((children[0] as Element).localName).toBe("rPr")
  })
})
