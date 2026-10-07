import { describe, it, expect } from "vitest"
import {
  decodeXmlEntities,
  elementsByTagName,
  firstElementByTagName,
  getAttribute,
  isElement,
  parseXmlLite,
  textContent,
} from "./xml-lite"

describe("parseXmlLite", () => {
  it("keeps namespace prefixes verbatim so OOXML tag names match", () => {
    const doc = parseXmlLite(`<w:document><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>`)
    expect(elementsByTagName(doc, "w:p")).toHaveLength(1)
    // A prefix-stripped lookup must NOT match — the parsers query "w:p".
    expect(elementsByTagName(doc, "p")).toHaveLength(0)
  })

  it("returns descendants in document order, like getElementsByTagName", () => {
    const doc = parseXmlLite(
      `<root><a><t>1</t></a><b><c><t>2</t></c><t>3</t></b><t>4</t></root>`,
    )
    expect(elementsByTagName(doc, "t").map((el) => textContent(el))).toEqual(["1", "2", "3", "4"])
  })

  it("reads attributes in both quote styles and decodes their entities", () => {
    const doc = parseXmlLite(`<r a="one" b='tw&amp;o' c="&#65;" />`)
    const r = firstElementByTagName(doc, "r")!
    expect(getAttribute(r, "a")).toBe("one")
    expect(getAttribute(r, "b")).toBe("tw&o")
    expect(getAttribute(r, "c")).toBe("A")
    expect(getAttribute(r, "missing")).toBeNull()
  })

  it("does not end a tag on a '>' inside an attribute value", () => {
    const doc = parseXmlLite(`<w:t w:val="a > b">text</w:t>`)
    const t = firstElementByTagName(doc, "w:t")!
    expect(getAttribute(t, "w:val")).toBe("a > b")
    expect(textContent(t)).toBe("text")
  })

  it("handles self-closing elements without unbalancing the stack", () => {
    const doc = parseXmlLite(`<a><b/><c><d/></c></a>`)
    expect(firstElementByTagName(doc, "b")!.children).toHaveLength(0)
    expect(elementsByTagName(doc, "d")).toHaveLength(1)
  })

  it("treats CDATA as literal text (no second round of entity decoding)", () => {
    const doc = parseXmlLite(`<a><![CDATA[raw &amp; <b>markup</b>]]></a>`)
    expect(textContent(firstElementByTagName(doc, "a")!)).toBe("raw &amp; <b>markup</b>")
  })

  it("skips the XML declaration, comments, and doctype", () => {
    const doc = parseXmlLite(
      `<?xml version="1.0"?><!DOCTYPE a><!-- note --><a>kept<!-- inline -->text</a>`,
    )
    expect(textContent(firstElementByTagName(doc, "a")!)).toBe("kepttext")
  })

  it("preserves significant whitespace inside text nodes", () => {
    const doc = parseXmlLite(`<w:t xml:space="preserve"> leading and trailing </w:t>`)
    expect(textContent(firstElementByTagName(doc, "w:t")!)).toBe(" leading and trailing ")
  })

  it("throws on mismatched or unclosed tags rather than parsing partially", () => {
    // A truncated upload must fail loudly — a silent partial parse is how half
    // a document turns into a complete-looking import.
    expect(() => parseXmlLite(`<a><b></a></b>`)).toThrow(/Malformed XML/)
    expect(() => parseXmlLite(`<a><b>text`)).toThrow(/Malformed XML/)
    expect(() => parseXmlLite(`<a></a></b>`)).toThrow(/Malformed XML/)
  })

  it("exposes text nodes distinctly from elements", () => {
    const doc = parseXmlLite(`<a>text<b/></a>`)
    const a = firstElementByTagName(doc, "a")!
    expect(a.children.filter((child) => !isElement(child))).toHaveLength(1)
    expect(a.children.filter(isElement).map((el) => el.tagName)).toEqual(["b"])
  })
})

describe("decodeXmlEntities", () => {
  it("decodes the five predefined entities", () => {
    expect(decodeXmlEntities("a&amp;b&lt;c&gt;d&quot;e&apos;f")).toBe(`a&b<c>d"e'f`)
  })

  it("decodes decimal and hex character references, including astral ones", () => {
    expect(decodeXmlEntities("&#8212;")).toBe("—")
    expect(decodeXmlEntities("&#x2014;")).toBe("—")
    expect(decodeXmlEntities("&#x1F600;")).toBe("\u{1F600}")
  })

  it("leaves unknown and out-of-range references untouched", () => {
    expect(decodeXmlEntities("&nbsp;")).toBe("&nbsp;")
    expect(decodeXmlEntities("&#x110000;")).toBe("&#x110000;")
  })
})
