import { describe, it, expect, vi, afterEach } from "vitest"
import DOMPurify from "dompurify"
import { plainTextToEditorHtml, prepareEditorContent } from "./editor-content"

// AQU-1063: the editor hydrates from HTML, so a stored PLAIN value has to be
// encoded on the way in. Handed to the parser raw, its newlines collapse to
// spaces and the next commit persists the collapse — a translator's deliberate
// Shift+Enter line break is destroyed. The plain fallback is reached whenever a
// writer commits `value` without `valueHtml` (an AI completion that returns no
// html clears `translatedHtml` on purpose), and by plain-only imported targets.
describe("plainTextToEditorHtml", () => {
  it("encodes a newline as the same <br> the editor emits for Shift+Enter", () => {
    expect(plainTextToEditorHtml("line one\nline two")).toBe("<p>line one<br>line two</p>")
  })

  it("keeps consecutive breaks distinct", () => {
    expect(plainTextToEditorHtml("a\n\nb")).toBe("<p>a<br><br>b</p>")
  })

  it("normalises CRLF and lone CR to a single break", () => {
    expect(plainTextToEditorHtml("a\r\nb")).toBe("<p>a<br>b</p>")
    expect(plainTextToEditorHtml("a\rb")).toBe("<p>a<br>b</p>")
  })

  it("preserves a trailing break rather than trimming it", () => {
    expect(plainTextToEditorHtml("a\n")).toBe("<p>a<br></p>")
  })

  it("wraps a single-line value in the editor's own one-paragraph shape", () => {
    expect(plainTextToEditorHtml("plain text")).toBe("<p>plain text</p>")
  })

  it("returns empty for an empty value", () => {
    expect(plainTextToEditorHtml("")).toBe("")
  })

  // Entity/tag handling is deliberately NOT changed here: legacy imports stored
  // HTML-escaped plain text and the committed baseline is seeded from the
  // editor's own post-parse serialisation (AQU-216).
  it("does not escape entities or tags in a plain value", () => {
    expect(plainTextToEditorHtml("a --&gt; b")).toBe("<p>a --&gt; b</p>")
  })
})

describe("prepareEditorContent", () => {
  // WHY THESE TESTS SPY ON THE SANITIZER INPUT RATHER THAN ASSERT ITS OUTPUT:
  // under happy-dom DOMPurify's DOM walk does not reproduce browser behaviour —
  // it drops `<p>`/`<span>` and keeps `<script>` — so an output-based assertion
  // here would encode the test environment's quirks, not the contract. Same
  // reasoning as source-display-sanitizer.test.ts. What is environment
  // independent is WHICH form each branch hands to the sanitizer: the plain
  // fallback must arrive encoded (no raw newline left to collapse), and stored
  // html must arrive untouched. The end-to-end proof that the break survives
  // into the document lives in TranslatedEditor.commit.test.tsx.
  function sanitizerInputFor(html: string | undefined, plain: string): string {
    const spy = vi.spyOn(DOMPurify, "sanitize")
    prepareEditorContent(html, plain)
    expect(spy).toHaveBeenCalled()
    return String(spy.mock.calls[0][0])
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("hands the sanitizer an encoded plain fallback, with no raw newline left to collapse", () => {
    const input = sanitizerInputFor(undefined, "line one\nline two")
    expect(input).toBe("<p>line one<br>line two</p>")
    expect(input).not.toContain("\n")
  })

  it("treats an empty html string as absent and still encodes the plain fallback", () => {
    expect(sanitizerInputFor("", "line one\nline two")).toBe("<p>line one<br>line two</p>")
  })

  it("prefers stored html and hands it over unchanged", () => {
    expect(sanitizerInputFor("<p>line one<br>line two</p>", "ignored"))
      .toBe("<p>line one<br>line two</p>")
  })

  it("does not encode newlines inside stored html (whitespace between tags is the parser's)", () => {
    expect(sanitizerInputFor("<p>a</p>\n<p>b</p>", "")).toBe("<p>a</p>\n<p>b</p>")
  })

  it("short-circuits to empty when both forms are empty", () => {
    expect(prepareEditorContent(undefined, "")).toBe("")
  })
})
