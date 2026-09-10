import type { IdmlStyleCatalog, IdmlStyleEmphasis } from "./types.js"
import { elementDescendants, getAttribute, parseXml } from "./xml.js"
import type { XmlDocument, XmlElement } from "./xml.js"

function emphasisFromFontStyle(fontStyle: string | undefined): IdmlStyleEmphasis {
  const normalized = fontStyle?.toLowerCase() ?? ""
  return {
    bold: /(?:^|[^a-z])(?:semi|demi)?-?bold(?:[^a-z]|$)/.test(normalized),
    italic: /(?:^|[^a-z])italic(?:[^a-z]|$)/.test(normalized),
  }
}

function elementText(element: XmlElement): string {
  let text = ""
  for (const child of element.children) {
    if (child.kind === "text" || child.kind === "cdata") text += child.value
    else if (child.kind === "element") text += elementText(child)
  }
  return text.trim()
}

type StylePrefix = "CharacterStyle/" | "ParagraphStyle/"

function stylePrefix(self: string): StylePrefix {
  return self.startsWith("ParagraphStyle/") ? "ParagraphStyle/" : "CharacterStyle/"
}

function normalizeStyleRef(value: string, prefix: StylePrefix): string {
  if (value.startsWith("CharacterStyle/") || value.startsWith("ParagraphStyle/")) return value
  return `${prefix}${value}`
}

/**
 * InDesign stores BasedOn either as an attribute or as
 * `<Properties><BasedOn>CharacterStyle/bd</BasedOn></Properties>`.
 */
function basedOnOf(element: XmlElement, prefix: StylePrefix): string | undefined {
  const attribute = getAttribute(element, "BasedOn")
  if (attribute) return normalizeStyleRef(attribute, prefix)
  for (const child of elementDescendants(element, (candidate) => candidate.localName === "BasedOn")) {
    const text = elementText(child)
    if (text) return normalizeStyleRef(text, prefix)
  }
  return undefined
}

function catalogFromDocument(document: XmlDocument): IdmlStyleCatalog {
  const styles = new Map<string, { basedOn?: string; fontStyle?: string }>()
  for (const element of elementDescendants(
    document.root,
    (candidate) => candidate.localName === "CharacterStyle" || candidate.localName === "ParagraphStyle",
  )) {
    const self = getAttribute(element, "Self")
    if (!self) continue
    const prefix = stylePrefix(self)
    styles.set(self, {
      basedOn: basedOnOf(element, prefix),
      fontStyle: getAttribute(element, "FontStyle"),
    })
  }

  const resolved = new Map<string, IdmlStyleEmphasis>()
  const visiting = new Set<string>()
  const resolve = (styleId: string): IdmlStyleEmphasis => {
    const cached = resolved.get(styleId)
    if (cached) return cached
    if (visiting.has(styleId)) return { bold: false, italic: false }
    const style = styles.get(styleId)
    if (!style) return { bold: false, italic: false }
    visiting.add(styleId)
    const inherited = style.basedOn ? resolve(style.basedOn) : { bold: false, italic: false }
    // An explicit FontStyle replaces the inherited face (Regular on a Bold
    // parent is roman, not Bold+Regular). Missing FontStyle inherits.
    const emphasis = style.fontStyle !== undefined
      ? emphasisFromFontStyle(style.fontStyle)
      : inherited
    visiting.delete(styleId)
    resolved.set(styleId, emphasis)
    return emphasis
  }

  const catalog: Record<string, IdmlStyleEmphasis> = {}
  for (const styleId of styles.keys()) {
    const emphasis = resolve(styleId)
    if (emphasis.bold || emphasis.italic) catalog[styleId] = emphasis
  }
  return catalog
}

/**
 * Bold/Italic faces from an IDML `Resources/Styles.xml` character- and
 * paragraph-style table. `BasedOn` is resolved; underline, color, and other
 * faces are ignored.
 */
export function extractIdmlStyleCatalog(stylesXml: string): IdmlStyleCatalog {
  return catalogFromDocument(parseXml(stylesXml, "Resources/Styles.xml"))
}

export function extractIdmlStyleCatalogFromDocument(
  document: XmlDocument | undefined,
): IdmlStyleCatalog {
  return document ? catalogFromDocument(document) : {}
}

export function styleCatalogForSlots(
  catalog: IdmlStyleCatalog,
  characterStyleIds: readonly string[],
): IdmlStyleCatalog | undefined {
  const used: Record<string, IdmlStyleEmphasis> = {}
  for (const styleId of characterStyleIds) {
    const emphasis = catalog[styleId]
    if (emphasis && (emphasis.bold || emphasis.italic)) used[styleId] = emphasis
  }
  return Object.keys(used).length > 0 ? used : undefined
}
