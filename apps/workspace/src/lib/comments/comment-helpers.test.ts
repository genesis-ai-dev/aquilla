import { describe, it, expect } from "vitest"
import { extractMentions, renderCommentHtml } from "./comment-helpers"

describe("extractMentions", () => {
  it("finds @username mentions", () => {
    expect(extractMentions("Hey @alice check this")).toEqual(["alice"])
  })

  it("finds multiple mentions", () => {
    expect(extractMentions("@alice and @bob_smith both")).toEqual(["alice", "bob_smith"])
  })

  it("deduplicates mentions", () => {
    expect(extractMentions("@alice talked to @alice")).toEqual(["alice"])
  })

  it("ignores email-like patterns", () => {
    expect(extractMentions("email me at foo@example.com")).toEqual([])
  })

  it("ignores standalone @ or @numeric", () => {
    expect(extractMentions("price @ 10 and @123 is not a user")).toEqual([])
  })

  it("handles empty", () => {
    expect(extractMentions("")).toEqual([])
    expect(extractMentions("no mentions here")).toEqual([])
  })
})

describe("renderCommentHtml", () => {
  it("renders plain text", () => {
    expect(renderCommentHtml("hello world")).toBe("hello world")
  })

  it("renders bold", () => {
    expect(renderCommentHtml("this is **bold** text")).toBe('this is <b>bold</b> text')
  })

  it("renders italic", () => {
    expect(renderCommentHtml("this is *italic* text")).toBe('this is <i>italic</i> text')
  })

  it("renders inline code", () => {
    expect(renderCommentHtml("use `console.log` here")).toBe('use <code>console.log</code> here')
  })

  it("renders mentions as styled spans", () => {
    expect(renderCommentHtml("ping @alice please")).toBe('ping <span class="mention">@alice</span> please')
  })

  it("escapes HTML to prevent XSS", () => {
    const result = renderCommentHtml("<script>alert(1)</script>")
    expect(result).not.toContain("<script>")
  })

  it("preserves newlines as <br>", () => {
    expect(renderCommentHtml("line one\nline two")).toBe("line one<br>line two")
  })
})
