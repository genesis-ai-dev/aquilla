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
  })
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
