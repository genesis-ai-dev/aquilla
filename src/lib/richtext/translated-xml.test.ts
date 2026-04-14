import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { getPlainText, getFragmentHtml, setPlainText, setFragmentFromHtml } from "./translated-xml"

function makeFragment(): Y.XmlFragment {
  const doc = new Y.Doc()
  return doc.getXmlFragment("test")
}

describe("getPlainText", () => {
  it("returns empty string for empty fragment", () => {
    const frag = makeFragment()
    expect(getPlainText(frag)).toBe("")
  })

  it("extracts text from a single paragraph", () => {
    const frag = makeFragment()
    setPlainText(frag, "Hello world")
    expect(getPlainText(frag)).toBe("Hello world")
  })

  it("joins multiple paragraphs with newlines", () => {
    const frag = makeFragment()
    setFragmentFromHtml(frag, "<p>Line one</p><p>Line two</p>")
    expect(getPlainText(frag)).toBe("Line one\nLine two")
  })

  it("preserves hard breaks as newlines", () => {
    const frag = makeFragment()
    setFragmentFromHtml(frag, "<p>Line one<br/>Line two</p>")
    expect(getPlainText(frag)).toBe("Line one\nLine two")
  })

  it("strips formatting marks when extracting text", () => {
    const frag = makeFragment()
    setFragmentFromHtml(frag, "<p>This is <strong>bold</strong> text</p>")
    expect(getPlainText(frag)).toBe("This is bold text")
  })
})

describe("setPlainText", () => {
  it("overwrites fragment with single paragraph containing the text", () => {
    const frag = makeFragment()
    setPlainText(frag, "hello")
    expect(getPlainText(frag)).toBe("hello")
  })

  it("handles empty string", () => {
    const frag = makeFragment()
    setPlainText(frag, "old content")
    setPlainText(frag, "")
    expect(getPlainText(frag)).toBe("")
  })

  it("replaces existing content", () => {
    const frag = makeFragment()
    setPlainText(frag, "first")
    setPlainText(frag, "second")
    expect(getPlainText(frag)).toBe("second")
  })

  it("splits newlines into hard breaks in a single paragraph", () => {
    const frag = makeFragment()
    setPlainText(frag, "line1\nline2")
    expect(getPlainText(frag)).toBe("line1\nline2")
  })
})

describe("getFragmentHtml", () => {
  it("returns empty for empty fragment", () => {
    const frag = makeFragment()
    expect(getFragmentHtml(frag)).toBe("")
  })

  it("emits paragraph markup", () => {
    const frag = makeFragment()
    setPlainText(frag, "hello")
    const html = getFragmentHtml(frag)
    expect(html).toContain("hello")
    expect(html).toContain("<p>")
  })

  it("preserves bold mark in HTML", () => {
    const frag = makeFragment()
    setFragmentFromHtml(frag, "<p><strong>bold</strong></p>")
    const html = getFragmentHtml(frag)
    expect(html).toMatch(/<(b|strong)>bold<\/(b|strong)>/)
  })
})

describe("setFragmentFromHtml", () => {
  it("accepts simple HTML", () => {
    const frag = makeFragment()
    setFragmentFromHtml(frag, "<p>hello</p>")
    expect(getPlainText(frag)).toBe("hello")
  })

  it("round-trips inline marks", () => {
    const frag = makeFragment()
    setFragmentFromHtml(frag, "<p>a <b>b</b> c <i>d</i> e</p>")
    const html = getFragmentHtml(frag)
    expect(html).toMatch(/<(b|strong)>b<\/(b|strong)>/)
    expect(html).toMatch(/<(i|em)>d<\/(i|em)>/)
  })
})
