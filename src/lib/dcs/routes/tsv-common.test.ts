// Prose-fidelity helpers: TSV escape unfolding + markdown → cell HTML.
//
// WHY these tests exist: unfoldingWord TSV prose embeds newlines as the
// LITERAL characters `\n` (the file cannot hold a real newline in a cell) and
// is written in markdown with rc:// / relative links that resolve nowhere in
// Aquilla. If any of this regresses, imported notes display "\n" pairs, raw
// `#`/`**` syntax, or broken links — the exact bugs this module fixes.

import { describe, it, expect } from "vitest"
import { unescapeTsvProse, stripUnresolvableLinks, tsvMarkdownToHtml } from "./tsv-common"

describe("unescapeTsvProse", () => {
  it("turns literal \\n into a real newline and \\t into a tab", () => {
    expect(unescapeTsvProse("line one\\nline two\\tend")).toBe("line one\nline two\tend")
  })

  it("turns literal \\\\ into one backslash", () => {
    expect(unescapeTsvProse("a\\\\b")).toBe("a\\b")
  })

  it("protects double-backslash first: \\\\n is backslash + letter n, NOT newline", () => {
    // Four source chars \ \ n → escaped backslash then plain "n".
    expect(unescapeTsvProse("a\\\\nb")).toBe("a\\nb")
  })

  it("leaves text without escapes untouched", () => {
    const s = "No escapes here. Just prose (with / slashes)."
    expect(unescapeTsvProse(s)).toBe(s)
  })
})

describe("stripUnresolvableLinks", () => {
  it("renders [[rc://…]] as its readable last segment", () => {
    expect(stripUnresolvableLinks("See [[rc://*/ta/man/translate/figs-metaphor]].")).toBe(
      "See figs-metaphor.",
    )
  })

  it("renders a relative .md link as its link text", () => {
    expect(stripUnresolvableLinks("See [1:1](../01/01.md) for more.")).toBe("See 1:1 for more.")
  })

  it("renders an inline rc:// link as its link text", () => {
    expect(stripUnresolvableLinks("[servant](rc://en/tw/dict/bible/other/servant)")).toBe("servant")
  })

  it("falls back to the target's tail when the link text is empty", () => {
    expect(stripUnresolvableLinks("[](../front/intro.md)")).toBe("intro")
  })

  it("keeps absolute http(s) links untouched", () => {
    const md = "Visit [uW](https://unfoldingword.org/tn) today."
    expect(stripUnresolvableLinks(md)).toBe(md)
  })
})

describe("tsvMarkdownToHtml", () => {
  it("renders headings, paragraphs, and lists (real en_tn intro-note shape)", () => {
    const md = "# Introduction to Titus\n\n## Part 1: General Introduction\n\n1. First\n2. Second"
    expect(tsvMarkdownToHtml(md)).toBe(
      "<h1>Introduction to Titus</h1><h2>Part 1: General Introduction</h2>" +
        "<ol><li>First</li><li>Second</li></ol>",
    )
  })

  it("renders inline bold/italic/code and joins wrapped paragraph lines", () => {
    expect(tsvMarkdownToHtml("The **hope** of\n_eternal_ `life`.")).toBe(
      "<p>The <b>hope</b> of <i>eternal</i> <code>life</code>.</p>",
    )
  })

  it("renders unordered lists and blockquotes", () => {
    expect(tsvMarkdownToHtml("- one\n- two\n\n> quoted")).toBe(
      "<ul><li>one</li><li>two</li></ul><blockquote><p>quoted</p></blockquote>",
    )
  })

  it("emits NO <a> for rc:// or relative links — readable text only", () => {
    const html = tsvMarkdownToHtml(
      "See [[rc://*/ta/man/translate/figs-metaphor]] and [1:1](../01/01.md).",
    )
    expect(html).toBe("<p>See figs-metaphor and 1:1.</p>")
    expect(html).not.toContain("<a")
  })

  it("keeps http(s) links as real anchors, with underscores in the href intact", () => {
    expect(tsvMarkdownToHtml("Read [the guide](https://example.org/a_b_c).")).toBe(
      '<p>Read <a href="https://example.org/a_b_c">the guide</a>.</p>',
    )
  })

  it("HTML-escapes prose so raw angle brackets cannot inject markup", () => {
    expect(tsvMarkdownToHtml('Use <b> & "quotes" carefully.')).toBe(
      "<p>Use &lt;b&gt; &amp; &quot;quotes&quot; carefully.</p>",
    )
  })

  it("does not corrupt digit runs in prose (anchor placeholders are PUA-fenced)", () => {
    expect(tsvMarkdownToHtml("See [x](https://e.org) in verses 0 and 1 today.")).toBe(
      '<p>See <a href="https://e.org">x</a> in verses 0 and 1 today.</p>',
    )
  })
})
