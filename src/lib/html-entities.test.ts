import { describe, expect, it } from "vitest"
import { decodeHtmlEntities } from "./html-entities"

const NBSP = " "

describe("decodeHtmlEntities", () => {
  it("decodes &nbsp; to a regular space so words are separated (AQU-674)", () => {
    expect(decodeHtmlEntities("hello&nbsp;world")).toBe("hello world")
  })

  it("decodes repeated entities embedded in Arabic-script text (AQU-674)", () => {
    // Migrated Algerian target text: literal entities between Arabic words.
    expect(decodeHtmlEntities("فِي&nbsp;خَلَقَ")).toBe(
      "فِي خَلَقَ",
    )
  })

  it("decodes numeric decimal and hex references to their exact code point", () => {
    // &#160; / &#xA0; are the numeric form of a non-breaking space (U+00A0);
    // faithful numeric decoding preserves the exact code point.
    expect(decodeHtmlEntities("a&#160;b")).toBe(`a${NBSP}b`)
    expect(decodeHtmlEntities("a&#xA0;b")).toBe(`a${NBSP}b`)
    expect(decodeHtmlEntities("&#233;")).toBe("é")
    expect(decodeHtmlEntities("&#65;")).toBe("A")
  })

  it("decodes common named entities", () => {
    expect(decodeHtmlEntities("&amp;")).toBe("&")
    expect(decodeHtmlEntities("&lt;tag&gt;")).toBe("<tag>")
    expect(decodeHtmlEntities("A&mdash;B")).toBe("A—B")
  })

  it("does not strip a legitimate literal ampersand (no over-decoding)", () => {
    expect(decodeHtmlEntities("Moses & Aaron")).toBe("Moses & Aaron")
    expect(decodeHtmlEntities("R&D budget")).toBe("R&D budget")
  })

  it("leaves unrecognised named references untouched", () => {
    expect(decodeHtmlEntities("&notanentity;")).toBe("&notanentity;")
  })

  it("returns input unchanged when there is no ampersand", () => {
    const s = "just plain text"
    expect(decodeHtmlEntities(s)).toBe(s)
  })

  it("handles empty input", () => {
    expect(decodeHtmlEntities("")).toBe("")
  })

  it("decodes multiple mixed entities in one pass", () => {
    expect(decodeHtmlEntities("&lt;a&gt;&nbsp;&amp;&nbsp;&lt;b&gt;")).toBe("<a> & <b>")
  })
})
