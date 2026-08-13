import DOMPurify from "dompurify"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"
import { injectFootnoteSpans } from "@/lib/richtext/usfm-plain-text"

const ALLOWED_TAGS = ["b", "strong", "i", "em", "u", "s", "strike", "del", "code", "p", "br", "span"]
const ALLOWED_ATTR = ["data-usfm-footnote"]

export interface ReadOnlyRichTextOptions {
  footnoteNumberOffset?: number
  showFootnoteTooltips?: boolean
}

// Normalise stored content (HTML or plain) into the form TipTap hydrates from:
// allowed inline marks only, with raw `\f...\f*` turned into footnote-node spans.
export function prepareEditorContent(html: string | undefined, plain: string): string {
  const base = html && html.length > 0 ? html : plain
  return sanitizeEditorHtml(base)
}

export function sanitizeEditorHtml(html: string): string {
  if (!html) return ""
  return DOMPurify.sanitize(injectFootnoteSpans(html), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  })
}

/**
 * Sanitizer for the read-only SOURCE cell surface.
 *
 * OPS-8 (docs/OPSEC-REVIEW-2026-08-13.md): this surface used to render
 * `cell.originalHtml` through `DOMPurify.sanitize()` with DEFAULT options.
 * Defaults stop scripts and event handlers — so this was never an XSS — but
 * they happily keep `<img src>`, `<a href>`, `<video>`, `<source>` and friends.
 * `extractHtmlStrings` stores an imported block's `innerHTML` verbatim
 * (src/lib/parsers/html.ts), so an HTML document handed to a team for import
 * could make every translator's browser fetch an attacker-controlled URL the
 * moment the cell scrolled into view: IP, user agent, and the exact minute a
 * named person was working on a named passage. That linkage is the single
 * highest-consequence datum this product holds, and the report-only CSP's
 * `img-src … https:` would not have stopped it.
 *
 * The fix is to render source text under the same allowlist the target side
 * has always used — which is also what the parsers actually produce, per the
 * SECURITY note in EditorTable. Round-trip export is unaffected: `exportHtml`
 * re-parses the original uploaded document, not this field.
 *
 * Separate from `sanitizeEditorHtml` only because that one also runs
 * `injectFootnoteSpans`, which would change how raw `\f…\f*` markers in source
 * text render. Same allowlist, no rewriting.
 */
export function sanitizeSourceDisplayHtml(html: string): string {
  if (!html) return ""
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  })
}

/**
 * The IDML editor accepts only the canonical protected-anchor vocabulary.
 * Keep this separate from the general rich-text sanitizer: allowing IDML data
 * attributes globally would turn ordinary spans into misleading pseudo
 * anchors, while allowing formatting tags inside an IDML slot would violate
 * the surgical-export contract.
 */
export function sanitizeIdmlEditorHtml(html: string): string {
  if (!html) return ""
  if (typeof document === "undefined") {
    // The protected schema requires an exact attribute allowlist. DOMPurify's
    // broad ALLOW_DATA_ATTR switch would admit arbitrary data-* attributes,
    // so environments without a DOM fail closed to inert text. The browser
    // editor path below reconstructs only the canonical IDML attributes.
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [],
      ALLOWED_ATTR: [],
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
    })
  }
  const template = document.createElement("template")
  template.innerHTML = html
  const dropContents = new Set([
    "SCRIPT",
    "STYLE",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "SVG",
    "MATH",
    "TEMPLATE",
    "NOSCRIPT",
  ])
  const cleanChildren = (parent: ParentNode) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove()
        continue
      }
      if (!(node instanceof HTMLElement)) continue
      if (dropContents.has(node.tagName)) {
        node.remove()
        continue
      }
      cleanChildren(node)

      const protectedKind = node.getAttribute("data-idml-protected")
      const isParagraph = node.tagName === "P"
      const isSlot = node.tagName === "SPAN" && protectedKind === "slot"
      const isToken = (
        (node.tagName === "SPAN" || node.tagName === "BR")
        && protectedKind === "token"
      )
      const isBareBreak = node.tagName === "BR" && protectedKind === null
      if (!isParagraph && !isSlot && !isToken && !isBareBreak) {
        node.replaceWith(...node.childNodes)
      }
    }
  }
  cleanChildren(template.content)

  for (const element of template.content.querySelectorAll<HTMLElement>("*")) {
    const allowed = new Set<string>()
    const protectedKind = element.getAttribute("data-idml-protected")
    if (element.tagName === "P" && element.hasAttribute("data-idml-version")) {
      allowed.add("data-idml-version")
    } else if (element.tagName === "SPAN" && protectedKind === "slot") {
      allowed.add("data-idml-slot")
      allowed.add("data-idml-character-style")
      allowed.add("data-idml-protected")
      if (element.getAttribute("contenteditable") === "false") allowed.add("contenteditable")
    } else if (
      (element.tagName === "SPAN" || element.tagName === "BR")
      && protectedKind === "token"
    ) {
      allowed.add("data-idml-token")
      allowed.add("data-idml-token-kind")
      allowed.add("data-idml-protected")
      allowed.add("contenteditable")
    }
    for (const attribute of [...element.attributes]) {
      if (!allowed.has(attribute.name)) element.removeAttribute(attribute.name)
    }
  }
  const container = document.createElement("div")
  container.append(template.content.cloneNode(true))
  return container.innerHTML
}

export function hasMeaningfulRichText(html: string | undefined): boolean {
  if (!html) return false
  return /<(b|strong|i|em|u|s|strike|del|code)\b/i.test(html)
}

export function prepareReadOnlyRichTextHtml(
  html: string,
  {
    footnoteNumberOffset = 0,
    showFootnoteTooltips = true,
  }: ReadOnlyRichTextOptions = {},
): string {
  const safeHtml = sanitizeEditorHtml(html)
  if (!safeHtml.includes("data-usfm-footnote")) return safeHtml
  if (typeof document === "undefined") return safeHtml

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${safeHtml}</body>`, "text/html")
  let ordinal = footnoteNumberOffset

  for (const marker of Array.from(doc.body.querySelectorAll<HTMLElement>("span[data-usfm-footnote]"))) {
    const raw = marker.getAttribute("data-usfm-footnote") ?? ""
    const note = extractUsfmFootnotes(raw)[0]
    ordinal += 1
    const explicitCaller = note?.caller && note.caller !== "+" && note.caller !== "-"
    const label = explicitCaller ? note.caller : String(ordinal)
    const tooltip = note?.text || note?.ref || "Footnote"
    const ariaLabel = `Footnote${note?.ref ? ` ${note.ref}` : ""}${note?.text ? `: ${note.text}` : ""}`

    marker.className = "usfm-footnote-marker"
    marker.setAttribute("role", "note")
    marker.setAttribute("aria-label", ariaLabel)
    marker.replaceChildren(doc.createTextNode(label))

    if (showFootnoteTooltips && tooltip) {
      const tooltipNode = doc.createElement("span")
      tooltipNode.className = "usfm-footnote-marker-tooltip"
      tooltipNode.setAttribute("role", "tooltip")
      tooltipNode.textContent = tooltip
      marker.append(tooltipNode)
    }
  }

  return doc.body.innerHTML
}
