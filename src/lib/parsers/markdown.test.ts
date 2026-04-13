import { describe, it, expect } from "vitest"
import { extractMarkdownStrings } from "./markdown"

describe("extractMarkdownStrings", () => {
  it("parses headings with correct context", () => {
    const md = "# Title\n\n## Subtitle"
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Title")
    expect(result[0].context).toBe("Heading 1")
    expect(result[0].type).toBe("heading")
    expect(result[1].original).toBe("Subtitle")
    expect(result[1].context).toBe("Heading 2")
  })

  it("parses paragraphs", () => {
    const md = "First paragraph.\n\nSecond paragraph."
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("First paragraph.")
    expect(result[0].context).toBe("Paragraph")
    expect(result[0].type).toBe("text")
  })

  it("parses list items", () => {
    const md = "- Item one\n- Item two\n* Item three"
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(3)
    expect(result[0].original).toBe("Item one")
    expect(result[0].type).toBe("list")
  })

  it("parses numbered list items", () => {
    const md = "1. First\n2. Second"
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("First")
    expect(result[0].type).toBe("list")
  })

  it("parses blockquotes", () => {
    const md = "> This is a quote"
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("This is a quote")
    expect(result[0].type).toBe("blockquote")
  })

  it("converts bold to originalHtml", () => {
    const md = "This is **bold** text"
    const result = extractMarkdownStrings(md)
    expect(result[0].originalHtml).toBe("This is <b>bold</b> text")
  })

  it("converts italic to originalHtml", () => {
    const md = "This is *italic* text"
    const result = extractMarkdownStrings(md)
    expect(result[0].originalHtml).toBe("This is <i>italic</i> text")
  })

  it("converts strikethrough to originalHtml", () => {
    const md = "This is ~~struck~~ text"
    const result = extractMarkdownStrings(md)
    expect(result[0].originalHtml).toBe("This is <s>struck</s> text")
  })

  it("converts inline code to originalHtml", () => {
    const md = "Use `console.log` here"
    const result = extractMarkdownStrings(md)
    expect(result[0].originalHtml).toBe("Use <code>console.log</code> here")
  })

  it("does not set originalHtml when no inline formatting", () => {
    const md = "Plain text paragraph"
    const result = extractMarkdownStrings(md)
    expect(result[0].originalHtml).toBeUndefined()
  })

  it("sets translated equal to original (plain text, no markdown)", () => {
    const md = "**Bold** text"
    const result = extractMarkdownStrings(md)
    expect(result[0].translated).toBe("")
  })
})
