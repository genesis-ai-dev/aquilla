import DOMPurify from "dompurify"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"
import { injectFootnoteSpans } from "@/lib/richtext/usfm-plain-text"

const ALLOWED_TAGS = ["b", "strong", "i", "em", "u", "s", "strike", "del", "code", "p", "br", "span"]
const ALLOWED_ATTR = ["data-usfm-footnote"]
const IDML_ALLOWED_TAGS = ["p", "br", "span"]
const IDML_ALLOWED_ATTR = [
  "data-idml-version",
  "data-idml-slot",
  "data-idml-character-style",
  "data-idml-protected",
  "data-idml-token",
  "data-idml-token-kind",
  "contenteditable",
]

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
 * The IDML editor accepts only the canonical protected-anchor vocabulary.
 * Keep this separate from the general rich-text sanitizer: allowing IDML data
 * attributes globally would turn ordinary spans into misleading pseudo
 * anchors, while allowing formatting tags inside an IDML slot would violate
 * the surgical-export contract.
 */
export function sanitizeIdmlEditorHtml(html: string): string {
  if (!html) return ""
  const safe = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: IDML_ALLOWED_TAGS,
    ALLOWED_ATTR: IDML_ALLOWED_ATTR,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  })
  if (typeof document === "undefined") return safe

  const template = document.createElement("template")
  template.innerHTML = safe
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
