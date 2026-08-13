// OPS-8 (docs/OPSEC-REVIEW-2026-08-13.md).
//
// The source cell surface rendered imported HTML through `DOMPurify.sanitize()`
// with DEFAULT options. Defaults are an XSS filter, not a content policy: in a
// real browser they keep `<img>`, `<a>`, `<video>` and `<source>`. Since
// `extractHtmlStrings` stores an imported block's `innerHTML` verbatim
// (src/lib/parsers/html.ts), a document handed to a translation team for import
// could make every member's browser fetch an attacker-controlled URL when the
// cell rendered — leaking each translator's IP, user agent and working hours
// against a named passage. The target surface never had this gap; it has always
// gone through the explicit allowlist in `sanitizeEditorHtml`.
//
// WHY THESE TESTS ASSERT CONFIG, NOT OUTPUT: under happy-dom, DOMPurify's DOM
// walk does not reproduce browser behaviour — it drops `<p>`, `<span>` and any
// element carrying an attribute, and it produces identical output for the
// default and the allowlisted config. So an output-based test here would pass
// against the vulnerable version too, which is worse than no test at all. What
// is environment-independent, and what actually went wrong, is the config: the
// source surface must sanitize under the same allowlist as the target surface,
// and that allowlist must contain nothing that can reference a remote URL.
import { describe, it, expect, vi, afterEach } from "vitest"
import DOMPurify from "dompurify"
import { sanitizeSourceDisplayHtml, sanitizeEditorHtml } from "./editor-content"

/** Every element that can make the browser fetch a URL on render or on click. */
const REMOTE_RESOURCE_TAGS = [
  "img",
  "a",
  "video",
  "audio",
  "source",
  "track",
  "iframe",
  "object",
  "embed",
  "svg",
  "image",
  "link",
  "style",
  "script",
  "form",
  "input",
]

function configFor(fn: (html: string) => string): Record<string, unknown> {
  const spy = vi.spyOn(DOMPurify, "sanitize")
  fn("<b>x</b>")
  expect(spy).toHaveBeenCalled()
  const config = spy.mock.calls[0][1]
  expect(config, "sanitizer must pass an explicit config, never DOMPurify defaults").toBeTruthy()
  return config as unknown as Record<string, unknown>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("sanitizeSourceDisplayHtml", () => {
  it("passes an explicit allowlist rather than relying on DOMPurify defaults", () => {
    const config = configFor(sanitizeSourceDisplayHtml)
    expect(Array.isArray(config.ALLOWED_TAGS)).toBe(true)
    expect(Array.isArray(config.ALLOWED_ATTR)).toBe(true)
    expect(config.ALLOW_DATA_ATTR).toBe(false)
    expect(config.ALLOW_ARIA_ATTR).toBe(false)
  })

  it("allows no element that can reference a remote URL", () => {
    const allowed = configFor(sanitizeSourceDisplayHtml).ALLOWED_TAGS as string[]
    for (const tag of REMOTE_RESOURCE_TAGS) {
      expect(allowed, `<${tag}> must not be renderable in a source cell`).not.toContain(tag)
    }
  })

  it("allows no attribute that can carry a URL", () => {
    const allowed = configFor(sanitizeSourceDisplayHtml).ALLOWED_ATTR as string[]
    for (const attr of ["src", "href", "srcset", "data", "action", "poster", "background"]) {
      expect(allowed).not.toContain(attr)
    }
  })

  it("uses the same allowlist as the target surface — the asymmetry was the bug", () => {
    const source = configFor(sanitizeSourceDisplayHtml)
    vi.restoreAllMocks()
    const target = configFor(sanitizeEditorHtml)
    expect(source.ALLOWED_TAGS).toEqual(target.ALLOWED_TAGS)
    expect(source.ALLOWED_ATTR).toEqual(target.ALLOWED_ATTR)
  })

  it("still keeps the inline formatting the parsers emit", () => {
    // markdown.ts emits <b>/<i>/<s>/<code>; docx/pptx add <u>/<strong>/<em>.
    const allowed = configFor(sanitizeSourceDisplayHtml).ALLOWED_TAGS as string[]
    for (const tag of ["b", "strong", "i", "em", "u", "s", "code", "p", "br", "span"]) {
      expect(allowed, `parsers emit <${tag}>; dropping it would degrade every import`).toContain(tag)
    }
  })

  it("returns empty for empty input without calling the sanitizer", () => {
    const spy = vi.spyOn(DOMPurify, "sanitize")
    expect(sanitizeSourceDisplayHtml("")).toBe("")
    expect(spy).not.toHaveBeenCalled()
  })
})
