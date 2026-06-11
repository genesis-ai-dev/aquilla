/**
 * markdown-plain.test.ts — chat UX improvements
 *
 * "Insert into cell" must put PLAIN text into the translation cell — markdown
 * syntax leaking into a committed cell would corrupt the translation.
 */

import { describe, it, expect } from "vitest"
import { markdownToPlainText } from "./markdown-plain"

describe("markdownToPlainText", () => {
  it("strips emphasis and inline code", () => {
    expect(markdownToPlainText("**Bold** and *italic* and `code` and ~~gone~~")).toBe(
      "Bold and italic and code and gone",
    )
  })

  it("strips headings and blockquotes", () => {
    expect(markdownToPlainText("## Heading\n> quoted line")).toBe("Heading\nquoted line")
  })

  it("keeps code content but drops fences", () => {
    expect(markdownToPlainText("```js\nconst x = 1\n```")).toBe("const x = 1")
  })

  it("unwraps links and images", () => {
    expect(markdownToPlainText("See [the docs](https://example.com) and ![alt text](img.png)")).toBe(
      "See the docs and alt text",
    )
  })

  it("strips list markers", () => {
    expect(markdownToPlainText("- first\n- second\n1. third")).toBe("first\nsecond\nthird")
  })

  it("flattens tables to text", () => {
    const md = "| a | b |\n| --- | --- |\n| one | two |"
    expect(markdownToPlainText(md)).toBe("a b\none two")
  })

  it("passes plain prose through unchanged", () => {
    const prose = "Au commencement, Dieu créa les cieux et la terre."
    expect(markdownToPlainText(prose)).toBe(prose)
  })
})
