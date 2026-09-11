import type { IdmlStyleCatalog, IdmlStyleEmphasis } from "@aquilla/idml-roundtrip"
import { sanitizeIdmlEditorHtml } from "@/lib/richtext/editor-content"

export const IDML_STYLE_BOLD_CLASS = "idml-style-bold"
export const IDML_STYLE_ITALIC_CLASS = "idml-style-italic"

export type { IdmlStyleCatalog }

function decodeCharacterStyleId(styleId: string): string {
  try {
    return decodeURIComponent(styleId)
  } catch {
    return styleId
  }
}

function styleName(styleId: string): string {
  const decoded = decodeCharacterStyleId(styleId)
  return decoded.replace(/^(CharacterStyle|ParagraphStyle)\//i, "")
}

function isDefaultCharacterStyle(styleId: string): boolean {
  if (!styleId) return true
  const name = styleName(styleId)
  return name === "$ID/[No character style]" || name === "[No character style]"
}

/** Last segment after `group:` so `notes:ft_it` and `cv:v` resolve independently. */
function characterStyleLeaf(name: string): string {
  const colon = name.lastIndexOf(":")
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase()
}

/**
 * Treasure Hunt heading paragraph leaves whose Styles.xml FontStyle is Bold /
 * Semibold. Fact heads (`!meta_fact_head`) are Regular and stay plain.
 * Needed for already-imported cells that have no style catalog.
 */
function treasureHuntParagraphLeafEmphasis(leaf: string): IdmlStyleEmphasis {
  const bold = leaf === "!head"
    || leaf === "!hunt_head"
    || leaf === "!meta_head"
    || leaf === "!meta_hunt_head"
    || leaf === "_intro_head"
    || leaf === "par_head"
    || leaf === "#treasurefact"
    || leaf === "#treasurehunt"
  return { bold, italic: false }
}

/**
 * Biblica / USFM character-style leaves that are Bold or Italic in the
 * shipped Styles.xml (`k` BasedOn `bd`, `it`/`em` BasedOn `#base.it`).
 * Needed for already-imported cells that have no style catalog.
 */
function usfmLeafEmphasis(leaf: string): IdmlStyleEmphasis {
  const bold = leaf === "bd"
    || leaf === "bdit"
    || leaf === "#base.bd"
    || leaf === "#base.bdit"
    || leaf === "k"
    || leaf.startsWith("k_")
    || leaf.endsWith("_bd")
  const italic = leaf === "it"
    || leaf === "em"
    || leaf === "bdit"
    || leaf === "#base.it"
    || leaf === "#base.bdit"
    || leaf.endsWith("_it")
    || leaf.includes("_it_")
  return { bold, italic }
}

/**
 * Word-boundary match for the only two IDML emphasis faces we surface.
 * "Embolden", "black", "heavy", and "oblique" stay plain — translators asked
 * to see Bold and Italic, not every InDesign weight/slant alias.
 */
function nameHasEmphasisToken(name: string, token: "bold" | "italic"): boolean {
  const compact = name.toLowerCase().replace(/[^a-z]+/g, "")
  if (token === "bold") {
    return /(?:^|[^a-z])bold(?:[^a-z]|$)/.test(name.toLowerCase())
      || compact.includes("bolditalic")
      || compact.includes("italicbold")
  }
  return /(?:^|[^a-z])italics?(?:[^a-z]|$)/.test(name.toLowerCase())
    || compact.includes("bolditalic")
    || compact.includes("italicbold")
}

/**
 * Resolve the display-only bold/italic faces for an imported character or
 * paragraph style. Catalog entries (FontStyle from Styles.xml) win; otherwise
 * the style id's last name tokens are used so already-imported cells still
 * render.
 */
export function idmlCharacterStyleEmphasis(
  styleId: string,
  catalog?: IdmlStyleCatalog,
): IdmlStyleEmphasis {
  const fromCatalog = catalog?.[styleId] ?? catalog?.[decodeCharacterStyleId(styleId)]
  if (fromCatalog) return fromCatalog
  const name = styleName(styleId)
  if (
    !name
    || name === "$ID/[No character style]"
    || name === "$ID/[No paragraph style]"
  ) {
    return { bold: false, italic: false }
  }
  const leaf = characterStyleLeaf(name)
  const usfm = usfmLeafEmphasis(leaf)
  const paragraph = treasureHuntParagraphLeafEmphasis(leaf)
  return {
    bold: usfm.bold || paragraph.bold || nameHasEmphasisToken(name, "bold"),
    italic: usfm.italic || paragraph.italic || nameHasEmphasisToken(name, "italic"),
  }
}

/** Paint Bold/Italic onto a live slot without adding persisted attributes. */
export function decorateIdmlStyleElement(
  element: HTMLElement,
  styleId = element.getAttribute("data-idml-character-style") ?? "",
  catalog?: IdmlStyleCatalog,
  paragraphStyleId?: string,
): void {
  const inheritParagraph = Boolean(paragraphStyleId) && isDefaultCharacterStyle(styleId)
  const { bold, italic } = idmlCharacterStyleEmphasis(
    inheritParagraph ? paragraphStyleId! : styleId,
    catalog,
  )
  element.classList.toggle(IDML_STYLE_BOLD_CLASS, bold)
  element.classList.toggle(IDML_STYLE_ITALIC_CLASS, italic)
  element.style.fontWeight = bold ? "700" : ""
  element.style.fontStyle = italic ? "italic" : ""
}

/**
 * Read-surface HTML for a protected IDML cell. Sanitizes first, then applies
 * display-only bold/italic on slots. The extra class/style attributes must
 * never be written back to a cell — the editor and export validators reject
 * them.
 */
export function prepareIdmlDisplayHtml(
  html: string,
  catalog?: IdmlStyleCatalog,
  paragraphStyleId?: string,
): string {
  const safe = sanitizeIdmlEditorHtml(html)
  if (!safe || typeof document === "undefined") return safe
  const template = document.createElement("template")
  template.innerHTML = safe
  for (const slot of template.content.querySelectorAll<HTMLElement>(
    "span[data-idml-protected=\"slot\"][data-idml-character-style]",
  )) {
    decorateIdmlStyleElement(
      slot,
      slot.getAttribute("data-idml-character-style") ?? "",
      catalog,
      paragraphStyleId,
    )
  }
  const container = document.createElement("div")
  container.append(template.content.cloneNode(true))
  return container.innerHTML
}

export function looksLikeIdmlHtml(html: string): boolean {
  return html.includes("data-idml-protected") || html.includes("data-idml-version")
}
