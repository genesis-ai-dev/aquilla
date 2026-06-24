import { describe, it, expect } from "vitest"
import { htmlToSpans, spansToRuns } from "./docx-runs"

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
})
