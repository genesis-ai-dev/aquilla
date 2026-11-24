import type { IdmlStyleCatalog, IdmlStyleEmphasis } from "@aquilla/idml-roundtrip"
import { sanitizeIdmlEditorHtml } from "@/lib/richtext/editor-content"

export const IDML_STYLE_BOLD_CLASS = "idml-style-bold"
export const IDML_STYLE_ITALIC_CLASS = "idml-style-italic"
export const IDML_STYLE_SMALL_CAPS_CLASS = "idml-style-small-caps"
/** Present on a slot whose translator-visible text is still empty. Display only. */
export const IDML_STYLE_SEGMENT_EMPTY_ATTR = "data-style-segment-empty"
/**
 * Display only. `label` is the single "Regular" hit target for an empty run of
 * consecutive plain slots. `join` is a later plain slot in that run: it stays
 * in the same typing space and draws neither a word nor a gap.
 */
export const IDML_PLAIN_GROUP_ATTR = "data-style-plain-group"
/**
 * Display only. Consecutive slots with the same bold/italic face paint as one
 * box: `start` and `end` keep the outer corners, `mid` keeps neither.
 */
export const IDML_EMPHASIS_GROUP_ATTR = "data-style-emphasis-group"
/**
 * Display only. One element around a whole same-face run, so a line wrap
 * stays inside that segment instead of starting a new box.
 */
export const IDML_EMPHASIS_RUN_ATTR = "data-style-emphasis-run"

/** A zero-width composition sentinel is not text the translator wrote. */
export function idmlSlotHasVisibleContent(text: string, hasBreak: boolean): boolean {
  return hasBreak || text.replace(/\u200b/g, "").length > 0
}

export function syncIdmlStyleSegmentEmpty(
  element: HTMLElement,
  text: string,
  hasBreak: boolean,
): void {
  element.toggleAttribute(
    IDML_STYLE_SEGMENT_EMPTY_ATTR,
    !idmlSlotHasVisibleContent(text, hasBreak),
  )
}

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
 * USFM `\nd` (name of deity) and `\sc`, plus Biblica's `#base.sc` parent and
 * layout suffixes (`nd_sp`, `add_nd`). Already-imported cells have no catalog
 * entry for these, because small caps was not a stored face yet.
 */
function leafIsSmallCaps(leaf: string): boolean {
  return leaf === "nd"
    || leaf === "sc"
    || leaf === "#base.sc"
    || leaf.startsWith("nd_")
    || leaf.startsWith("sc_")
    || leaf.endsWith("_nd")
    || leaf.endsWith("_sc")
    || leaf.includes("_nd_")
    || leaf.includes("_sc_")
}

function nameIsSmallCaps(name: string): boolean {
  return name.toLowerCase().replace(/[^a-z]+/g, "").includes("smallcaps")
}

function namedSmallCaps(styleId: string): boolean {
  const name = styleName(styleId)
  if (!name || name.startsWith("$ID/")) return false
  return leafIsSmallCaps(characterStyleLeaf(name)) || nameIsSmallCaps(name)
}

function withSmallCaps(emphasis: IdmlStyleEmphasis, smallCaps: boolean): IdmlStyleEmphasis {
  if (!smallCaps || emphasis.smallCaps) return emphasis
  return { bold: emphasis.bold, italic: emphasis.italic, smallCaps: true }
}

/** Bold, italic, or small caps — a run the cell draws and can drag as its own segment. */
export function idmlStyleIsEmphasis(emphasis: IdmlStyleEmphasis): boolean {
  return emphasis.bold || emphasis.italic || emphasis.smallCaps === true
}

/**
 * Word-boundary match for the bold and italic faces we surface.
 * "Embolden", "black", "heavy", and "oblique" stay plain — translators asked
 * to see Bold and Italic, not every InDesign weight/slant alias. Small caps
 * is a separate face (`namedSmallCaps`).
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
 * Resolve the display faces for an imported character or paragraph style.
 * Catalog entries (FontStyle and Capitalization from Styles.xml) win for
 * weight. Small caps also comes from the style name, so a divine-name run
 * imported before small caps was stored still renders. Already-imported
 * cells with no catalog use the style id's last name tokens.
 */
export function idmlCharacterStyleEmphasis(
  styleId: string,
  catalog?: IdmlStyleCatalog,
): IdmlStyleEmphasis {
  const fromCatalog = catalog?.[styleId] ?? catalog?.[decodeCharacterStyleId(styleId)]
  const smallCaps = namedSmallCaps(styleId)
  if (fromCatalog) return withSmallCaps(fromCatalog, smallCaps)
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
  return withSmallCaps({
    bold: usfm.bold || paragraph.bold || nameHasEmphasisToken(name, "bold"),
    italic: usfm.italic || paragraph.italic || nameHasEmphasisToken(name, "italic"),
  }, smallCaps)
}

/** Paint bold, italic, and small caps onto a live slot without adding persisted attributes. */
export function decorateIdmlStyleElement(
  element: HTMLElement,
  styleId = element.getAttribute("data-idml-character-style") ?? "",
  catalog?: IdmlStyleCatalog,
  paragraphStyleId?: string,
): void {
  const inheritParagraph = Boolean(paragraphStyleId) && isDefaultCharacterStyle(styleId)
  const emphasis = idmlCharacterStyleEmphasis(
    inheritParagraph ? paragraphStyleId! : styleId,
    catalog,
  )
  const smallCaps = emphasis.smallCaps === true
  element.classList.toggle(IDML_STYLE_BOLD_CLASS, emphasis.bold)
  element.classList.toggle(IDML_STYLE_ITALIC_CLASS, emphasis.italic)
  element.classList.toggle(IDML_STYLE_SMALL_CAPS_CLASS, smallCaps)
  element.style.fontWeight = emphasis.bold ? "700" : ""
  element.style.fontStyle = emphasis.italic ? "italic" : ""
  // InDesign SmallCaps draws lowercase as small caps and leaves capitals
  // full size. all-small-caps also shrinks an all-caps SENHOR, which is the
  // word translators type inside this run. Export still writes the InDesign
  // character style; this property is display only.
  element.style.fontVariantCaps = smallCaps ? "all-small-caps" : ""
}

/**
 * Read-surface HTML for a protected IDML cell. Sanitizes first, then applies
 * display-only bold, italic, and small caps on slots. The extra class/style
 * attributes must never be written back to a cell — the editor and export
 * validators reject them.
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
    syncIdmlStyleSegmentEmpty(slot, slot.textContent ?? "", Boolean(slot.querySelector("br")))
  }
  syncIdmlPlainGroups(template.content)
  wrapIdmlEmphasisRuns(template.content)
  const container = document.createElement("div")
  container.append(template.content.cloneNode(true))
  return container.innerHTML
}

export function looksLikeIdmlHtml(html: string): boolean {
  return html.includes("data-idml-protected") || html.includes("data-idml-version")
}

/**
 * Consecutive plain slots are one part. An empty run shows a single Regular
 * on its first slot; every following plain slot joins that space. Bold,
 * italic, small caps, and tokens break the run, matching Align styles.
 */
export function syncIdmlPlainGroups(root: ParentNode): void {
  const paragraphs = [...root.querySelectorAll("p")]
  const hosts = paragraphs.length > 0 ? paragraphs : [root]
  for (const host of hosts) {
    markPlainGroup(host)
    markEmphasisGroup(host)
  }
}

function markPlainGroup(parent: ParentNode): void {
  let group: HTMLElement[] = []
  const close = () => {
    const anyText = group.some((slot) => !slot.hasAttribute(IDML_STYLE_SEGMENT_EMPTY_ATTR))
    group.forEach((slot, index) => {
      if (!slot.hasAttribute(IDML_STYLE_SEGMENT_EMPTY_ATTR)) {
        slot.removeAttribute(IDML_PLAIN_GROUP_ATTR)
        return
      }
      slot.setAttribute(
        IDML_PLAIN_GROUP_ATTR,
        !anyText && index === 0 ? "label" : "join",
      )
    })
    group = []
  }
  for (const child of parent.children) {
    if (!(child instanceof HTMLElement) || !isPlainSlot(child)) {
      if (child instanceof HTMLElement) child.removeAttribute(IDML_PLAIN_GROUP_ATTR)
      close()
      continue
    }
    group.push(child)
  }
  close()
}

/**
 * Put each same-face run in one inline element. The segment box is drawn on
 * that element, so "Simply Trinity" stays one segment when the line wraps.
 * The editor keeps the slots unwrapped; this is display HTML only.
 */
export function wrapIdmlEmphasisRuns(root: ParentNode): void {
  const paragraphs = [...root.querySelectorAll("p")]
  const hosts = paragraphs.length > 0 ? paragraphs : [root]
  for (const host of hosts) wrapEmphasisRun(host)
}

function wrapEmphasisRun(parent: ParentNode): void {
  const children = [...parent.children]
  let index = 0
  while (index < children.length) {
    const child = children[index]
    if (!(child instanceof HTMLElement) || child.getAttribute(IDML_EMPHASIS_GROUP_ATTR) !== "start") {
      index += 1
      continue
    }
    const run = [child]
    index += 1
    while (index < children.length) {
      const next = children[index]
      if (!(next instanceof HTMLElement)) break
      const role = next.getAttribute(IDML_EMPHASIS_GROUP_ATTR)
      if (role !== "mid" && role !== "end") break
      run.push(next)
      index += 1
      if (role === "end") break
    }
    const face = emphasisFace(run[0]!)
    if (!face || run.length < 2) continue
    const wrapper = document.createElement("span")
    wrapper.setAttribute(IDML_EMPHASIS_RUN_ATTR, face)
    run[0]!.before(wrapper)
    wrapper.append(...run)
  }
}

function isPlainSlot(element: HTMLElement): boolean {
  return element.getAttribute("data-idml-protected") === "slot"
    && !element.classList.contains(IDML_STYLE_BOLD_CLASS)
    && !element.classList.contains(IDML_STYLE_ITALIC_CLASS)
    && !element.classList.contains(IDML_STYLE_SMALL_CAPS_CLASS)
}

/** Bold, italic, or both. Plain slots and tokens return null and break the run. */
function emphasisFace(element: HTMLElement): "bold" | "italic" | "bold-italic" | null {
  if (element.getAttribute("data-idml-protected") !== "slot") return null
  const bold = element.classList.contains(IDML_STYLE_BOLD_CLASS)
  const italic = element.classList.contains(IDML_STYLE_ITALIC_CLASS)
  if (bold && italic) return "bold-italic"
  if (bold) return "bold"
  if (italic) return "italic"
  return null
}

/**
 * InDesign tracking stores one character range per letter, so a title arrives
 * as many slots with the same face. They are one phrase on the page.
 */
function markEmphasisGroup(parent: ParentNode): void {
  let face: string | null = null
  let group: HTMLElement[] = []
  const close = () => {
    if (group.length >= 2) {
      group.forEach((slot, index) => {
        const role = index === 0 ? "start" : index === group.length - 1 ? "end" : "mid"
        slot.setAttribute(IDML_EMPHASIS_GROUP_ATTR, role)
      })
    } else {
      group[0]?.removeAttribute(IDML_EMPHASIS_GROUP_ATTR)
    }
    group = []
    face = null
  }
  for (const child of parent.children) {
    if (!(child instanceof HTMLElement)) continue
    const next = emphasisFace(child)
    if (!next || (face !== null && next !== face)) {
      child.removeAttribute(IDML_EMPHASIS_GROUP_ATTR)
      close()
      if (!next) continue
    }
    face = next
    group.push(child)
  }
  close()
}
