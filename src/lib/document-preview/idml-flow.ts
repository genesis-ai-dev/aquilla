// An InDesign (IDML) package as flowing text: every story in reading order,
// with its paragraph and character styles, and no page geometry.
//
// No browser library draws IDML, and a package has no page images, so this is
// not the page. It is what can be drawn truthfully from the package alone:
// which text there is, in what order, and how each paragraph is styled
// (size, weight, alignment, indents, colour). Frames, columns, pictures and
// the designer's fonts are not shown.
//
// Reading order comes from the spreads: a story sits where its first text
// frame sits, pages left to right and frames top to bottom. `designmap.xml`
// lists stories in the order they were created, which is not the order a
// reader meets them. Stories only a master spread places (running heads) are
// left out; a story in an anchored frame is drawn where its anchor is.

import JSZip from "jszip"

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/**
 * InDesign writes special characters (a footnote's own number, an automatic
 * page number) as processing instructions such as `<?ACE 4?>`. They have no
 * text to draw, so they are dropped before parsing.
 */
const PROCESSING_INSTRUCTION = /<\?(?!xml[\s?])[^?]*(?:\?(?!>)[^?]*)*\?>/g

function parse(xml: string): Element | null {
  const doc = new DOMParser().parseFromString(xml.replace(PROCESSING_INSTRUCTION, ""), "application/xml")
  return doc.getElementsByTagName("parsererror").length > 0 ? null : doc.documentElement
}

/** U+2028, InDesign's forced line break inside a paragraph. */
const LINE_SEPARATOR = String.fromCharCode(0x2028)

const kids = (el: Element): Element[] => Array.from(el.children)
const num = (value: string | null | undefined): number | null => {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const pt = (n: number): string => `${Math.round(n * 100) / 100}pt`

// ---------------------------------------------------------------- styles ---

/** The style attributes this preview draws. Anything else is left to the page. */
const DRAWN = [
  "PointSize", "FontStyle", "Justification", "FirstLineIndent", "LeftIndent", "RightIndent",
  "SpaceBefore", "SpaceAfter", "FillColor", "Capitalization", "Underline", "StrikeThru", "Position",
] as const

type StyleProps = Partial<Record<(typeof DRAWN)[number] | "AppliedFont" | "Leading", string>>

function ownProps(el: Element): StyleProps {
  const props: StyleProps = {}
  for (const name of DRAWN) {
    const value = el.getAttribute(name)
    if (value !== null) props[name] = value
  }
  const properties = kids(el).find((k) => k.localName === "Properties")
  for (const child of properties ? kids(properties) : []) {
    if (child.localName === "AppliedFont" || child.localName === "Leading") {
      const text = (child.textContent ?? "").trim()
      if (text) props[child.localName] = text
    }
  }
  return props
}

function basedOn(el: Element): string | null {
  const attr = el.getAttribute("BasedOn")
  if (attr) return attr
  const properties = kids(el).find((k) => k.localName === "Properties")
  const child = properties ? kids(properties).find((k) => k.localName === "BasedOn") : undefined
  return (child?.textContent ?? "").trim() || null
}

interface Palette {
  /** CSS colour by swatch id (`Color/Black`). Missing: not drawable. */
  colors: Map<string, string>
}

function readPalette(graphic: Element | null): Palette {
  const colors = new Map<string, string>()
  for (const el of graphic ? Array.from(graphic.getElementsByTagName("Color")) : []) {
    const self = el.getAttribute("Self")
    const values = (el.getAttribute("ColorValue") ?? "").trim().split(/\s+/).map(Number)
    if (!self || values.some((v) => !Number.isFinite(v))) continue
    let rgb: number[] | null = null
    const space = el.getAttribute("Space")
    if (space === "RGB" && values.length === 3) rgb = values
    else if (space === "CMYK" && values.length === 4) {
      const [c, m, y, k] = values.map((v) => v / 100)
      rgb = [c, m, y].map((v) => 255 * (1 - v) * (1 - k))
    }
    if (!rgb) continue
    // The preview's page is white. Text in a near-white swatch sits on a dark
    // frame in the layout, which is not drawn here, so it keeps the page's ink.
    const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
    if (luminance > 0.85) continue
    colors.set(self, `rgb(${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v)))).join(",")})`)
  }
  return { colors }
}

const ALIGN: Record<string, string> = {
  LeftAlign: "left", CenterAlign: "center", RightAlign: "right",
  LeftJustified: "justify", CenterJustified: "justify", RightJustified: "justify", FullyJustified: "justify",
  ToBindingSide: "left", AwayFromBindingSide: "right",
}

function css(props: StyleProps, palette: Palette, block: boolean): string {
  const out: string[] = []
  const size = num(props.PointSize)
  if (size && size > 0) out.push(`font-size:${pt(size)}`)
  if (props.AppliedFont) {
    const family = props.AppliedFont.replace(/[^\p{L}\p{N} _-]/gu, "").trim()
    if (family) out.push(`font-family:"${family}",serif`)
  }
  if (props.FontStyle !== undefined) {
    const face = props.FontStyle.toLowerCase()
    out.push(`font-weight:${/black|heavy/.test(face) ? 900 : /bold/.test(face) ? 700 : /light|thin/.test(face) ? 300 : 400}`)
    out.push(`font-style:${/italic|oblique/.test(face) ? "italic" : "normal"}`)
  }
  const color = props.FillColor ? palette.colors.get(props.FillColor) : undefined
  if (color) out.push(`color:${color}`)
  if (props.Capitalization !== undefined) {
    const caps = props.Capitalization
    out.push(`text-transform:${caps === "AllCaps" ? "uppercase" : "none"}`)
    out.push(`font-variant-caps:${/small/i.test(caps) ? "small-caps" : "normal"}`)
  }
  const lines = [props.Underline === "true" ? "underline" : "", props.StrikeThru === "true" ? "line-through" : ""].filter(Boolean)
  if (lines.length > 0) out.push(`text-decoration:${lines.join(" ")}`)
  else if (props.Underline === "false" || props.StrikeThru === "false") out.push("text-decoration:none")
  if (props.Position !== undefined) {
    const raised = /superscript/i.test(props.Position)
    const lowered = /subscript/i.test(props.Position)
    out.push(`vertical-align:${raised ? "super" : lowered ? "sub" : "baseline"}`)
    if (raised || lowered) out.push("font-size:0.7em")
  }
  if (block) {
    const align = props.Justification ? ALIGN[props.Justification] : undefined
    if (align) out.push(`text-align:${align}`)
    const leading = num(props.Leading)
    if (leading && leading > 0) out.push(`line-height:${pt(leading)}`)
    const pairs: [keyof StyleProps, string][] = [
      ["FirstLineIndent", "text-indent"], ["LeftIndent", "margin-inline-start"], ["RightIndent", "margin-inline-end"],
      ["SpaceBefore", "margin-top"], ["SpaceAfter", "margin-bottom"],
    ]
    for (const [name, property] of pairs) {
      const value = num(props[name])
      if (value !== null) out.push(`${property}:${pt(value)}`)
    }
  }
  return out.join(";")
}

interface StyleSheet {
  /** Class name for a style id, when the style is known. */
  classFor(styleId: string | null): string
  /** Inline CSS for attributes set on a range itself, over its style. */
  local(el: Element, block: boolean): string
  cssText(): string
}

function readStyles(stylesRoot: Element | null, palette: Palette): StyleSheet {
  const defs = new Map<string, { props: StyleProps; parent: string | null; block: boolean }>()
  for (const tag of ["ParagraphStyle", "CharacterStyle"] as const) {
    for (const el of stylesRoot ? Array.from(stylesRoot.getElementsByTagName(tag)) : []) {
      const self = el.getAttribute("Self")
      if (self) defs.set(self, { props: ownProps(el), parent: basedOn(el), block: tag === "ParagraphStyle" })
    }
  }
  const resolved = new Map<string, StyleProps>()
  const resolve = (id: string, seen: Set<string>): StyleProps => {
    const cached = resolved.get(id)
    if (cached) return cached
    const def = defs.get(id)
    if (!def || seen.has(id)) return {}
    seen.add(id)
    const parentId = def.parent && !defs.has(def.parent)
      ? `${def.block ? "ParagraphStyle" : "CharacterStyle"}/${def.parent}`
      : def.parent
    const props = { ...(parentId ? resolve(parentId, seen) : {}), ...def.props }
    resolved.set(id, props)
    return props
  }
  const classes = new Map<string, string>()
  const rules: string[] = []
  let n = 0
  for (const [id, def] of defs) {
    const text = css(resolve(id, new Set()), palette, def.block)
    if (!text) continue
    const name = `${def.block ? "ps" : "cs"}${n++}`
    classes.set(id, name)
    rules.push(`.${name}{${text}}`)
  }
  return {
    classFor: (styleId) => (styleId ? classes.get(styleId) ?? "" : ""),
    local: (el, block) => css(ownProps(el), palette, block),
    cssText: () => rules.join("\n"),
  }
}

// ---------------------------------------------------------- reading order ---

interface Placement { page: number; pageName: string | null; y: number; x: number }

/** `ItemTransform` is "a b c d tx ty"; a point maps to (a·x + c·y + tx, b·x + d·y + ty). */
function transformOf(el: Element): number[] {
  const values = (el.getAttribute("ItemTransform") ?? "").trim().split(/\s+/).map(Number)
  return values.length === 6 && values.every(Number.isFinite) ? values : [1, 0, 0, 1, 0, 0]
}

function topLeft(frame: Element): { x: number; y: number; cx: number } {
  // Compose the frame's own transform with those of the groups it sits in.
  let m = transformOf(frame)
  for (let up = frame.parentElement; up && up.localName !== "Spread" && up.localName !== "MasterSpread"; up = up.parentElement) {
    const o = transformOf(up)
    m = [
      o[0] * m[0] + o[2] * m[1], o[1] * m[0] + o[3] * m[1],
      o[0] * m[2] + o[2] * m[3], o[1] * m[2] + o[3] * m[3],
      o[0] * m[4] + o[2] * m[5] + o[4], o[1] * m[4] + o[3] * m[5] + o[5],
    ]
  }
  const points = Array.from(frame.getElementsByTagName("PathPointType"))
    .map((p) => (p.getAttribute("Anchor") ?? "").trim().split(/\s+/).map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite))
    .map(([x, y]) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }))
  if (points.length === 0) return { x: m[4], y: m[5], cx: m[4] }
  const xs = points.map((p) => p.x)
  return { x: Math.min(...xs), y: Math.min(...points.map((p) => p.y)), cx: (Math.min(...xs) + Math.max(...xs)) / 2 }
}

/** Where each story starts, for the stories some spread places. */
function placeStories(spreads: Element[]): Map<string, Placement> {
  const placed = new Map<string, Placement>()
  let pageBase = 0
  for (const spreadRoot of spreads) {
    const spread = spreadRoot.localName === "Spread" ? spreadRoot : spreadRoot.getElementsByTagName("Spread")[0]
    if (!spread) continue
    const pages = Array.from(spread.getElementsByTagName("Page"))
      .map((page) => {
        const bounds = (page.getAttribute("GeometricBounds") ?? "").trim().split(/\s+/).map(Number)
        const tx = transformOf(page)[4]
        const width = bounds.length === 4 && bounds.every(Number.isFinite) ? bounds[3] - bounds[1] : 0
        return { left: tx, right: tx + width, name: page.getAttribute("Name") }
      })
      .sort((a, b) => a.left - b.left)
    for (const frame of Array.from(spread.querySelectorAll("[ParentStory]"))) {
      const story = frame.getAttribute("ParentStory")
      if (!story) continue
      const at = topLeft(frame)
      let index = pages.findIndex((p) => at.cx >= p.left && at.cx < p.right)
      if (index < 0) index = pages.length > 0 && at.cx >= pages[pages.length - 1].right ? pages.length - 1 : 0
      const next: Placement = { page: pageBase + index, pageName: pages[index]?.name ?? null, y: at.y, x: at.x }
      const prior = placed.get(story)
      if (!prior || comparePlacement(next, prior) < 0) placed.set(story, next)
    }
    pageBase += Math.max(1, pages.length)
  }
  return placed
}

function comparePlacement(a: Placement, b: Placement): number {
  // Frames whose tops are within a few points share a row: left one first.
  return a.page - b.page || (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x)
}

// --------------------------------------------------------------- stories ---

interface Draw {
  styles: StyleSheet
  stories: Map<string, Element>
  /** Stories already drawn or being drawn: a story is drawn once. */
  used: Set<string>
}

/** Inline objects that are drawings or pictures, not text: each shows as a small box. */
const PAGE_ITEMS = new Set(["Rectangle", "Oval", "Polygon", "GraphicLine", "Group", "Image", "PDF", "EPS", "ImportedPage"])

const attr = (name: string, value: string): string => (value ? ` ${name}="${escapeHtml(value)}"` : "")

/** The paragraphs of a story, table cell or note, as HTML blocks. */
function drawBlocks(container: Element, draw: Draw): string {
  let html = ""
  for (const child of kids(container)) {
    if (child.localName === "ParagraphStyleRange") html += drawParagraphRange(child, draw)
    else if (child.localName === "XMLElement" || child.localName === "Change") html += drawBlocks(child, draw)
    else if (child.localName === "Table") html += drawTable(child, draw)
    else if (child.localName === "Footnote" || child.localName === "EndnoteRange") html += `<div class="note">${drawBlocks(child, draw)}</div>`
  }
  return html
}

function drawParagraphRange(range: Element, draw: Draw): string {
  const open = `<p dir="auto"${attr("class", draw.styles.classFor(range.getAttribute("AppliedParagraphStyle")))}${attr("style", draw.styles.local(range, true))}>`
  let out = ""
  let line = ""
  let after = ""
  let notes = ""
  let noteCount = 0
  const endParagraph = () => {
    out += `${open}${line}</p>${after}`
    line = ""
    after = ""
  }
  const walk = (el: Element, span: string | null) => {
    const wrap = (text: string) => (span && text ? `${span}${text}</span>` : text)
    for (const child of kids(el)) {
      switch (child.localName) {
        case "CharacterStyleRange": {
          const cls = draw.styles.classFor(child.getAttribute("AppliedCharacterStyle"))
          const local = draw.styles.local(child, false)
          walk(child, cls || local ? `<span${attr("class", cls)}${attr("style", local)}>` : null)
          break
        }
        case "Content":
          line += wrap(escapeHtml(child.textContent ?? "").split(LINE_SEPARATOR).join("<br>"))
          break
        case "Br":
          endParagraph()
          break
        case "Table":
          after += drawTable(child, draw)
          break
        case "Footnote":
        case "EndnoteRange":
          noteCount++
          line += `<sup class="note-mark">${noteCount}</sup>`
          notes += `<div class="note"><sup class="note-mark">${noteCount}</sup>${drawBlocks(child, draw)}</div>`
          break
        case "Note":
          // An editorial note: it is not part of the printed text.
          break
        case "Change":
          if (child.getAttribute("ChangeType") !== "DeletedText") walk(child, span)
          break
        case "Properties":
          break
        default: {
          const story = child.getAttribute("ParentStory")
          if (story) after += drawAnchored(story, draw)
          else if (PAGE_ITEMS.has(child.localName)) line += `<span class="picture" aria-hidden="true"></span>`
          else walk(child, span)
        }
      }
    }
  }
  walk(range, null)
  if (line || after) endParagraph()
  return out + notes
}

function drawAnchored(storyId: string, draw: Draw): string {
  const story = draw.stories.get(storyId)
  if (!story || draw.used.has(storyId)) return ""
  draw.used.add(storyId)
  const body = drawBlocks(story, draw)
  return body ? `<aside class="anchored">${body}</aside>` : ""
}

function drawTable(table: Element, draw: Draw): string {
  const rows = new Map<number, { col: number; html: string }[]>()
  for (const cell of kids(table).filter((k) => k.localName === "Cell")) {
    // A cell is named "column:row".
    const [col, row] = (cell.getAttribute("Name") ?? "").split(":").map(Number)
    if (!Number.isFinite(col) || !Number.isFinite(row)) continue
    const rowSpan = num(cell.getAttribute("RowSpan")) ?? 1
    const colSpan = num(cell.getAttribute("ColumnSpan")) ?? 1
    const span = `${rowSpan > 1 ? ` rowspan="${Math.floor(rowSpan)}"` : ""}${colSpan > 1 ? ` colspan="${Math.floor(colSpan)}"` : ""}`
    const list = rows.get(row) ?? []
    list.push({ col, html: `<td${span}>${drawBlocks(cell, draw)}</td>` })
    rows.set(row, list)
  }
  const body = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, cells]) => `<tr>${cells.sort((a, b) => a.col - b.col).map((c) => c.html).join("")}</tr>`)
    .join("")
  return body ? `<table>${body}</table>` : ""
}

// ------------------------------------------------------------------ page ---

const PAGE_CSS = `
.idml-flow{max-width:46em;margin:12px auto;padding:2.5em 3em;background:#fff;color:#111;box-shadow:0 1px 4px rgba(0,0,0,.25);font:11pt/1.4 Georgia,"Times New Roman",serif;overflow-wrap:break-word;box-sizing:border-box}
.idml-flow p{margin:0;white-space:pre-wrap;tab-size:4}
.idml-flow p:empty::before{content:"\\200b"}
.idml-flow .story+.story{margin-top:1.4em;padding-top:1.4em;border-top:1px dashed #c8c8cc}
.idml-flow .page-mark{margin:0 0 .8em;font:600 8pt/1.2 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#8a8a92}
.idml-flow .anchored{margin:.6em 0;padding:.5em .8em;border:1px solid #d4d4d8;border-radius:3px;background:#fafafa}
.idml-flow .note{margin-top:.5em;padding-top:.3em;border-top:1px solid #d4d4d8;font-size:.85em;display:flex;gap:.4em}
.idml-flow .note-mark{font-size:.7em;vertical-align:super;color:#555}
.idml-flow .picture{display:inline-block;width:1.6em;height:1.1em;margin:0 .15em;vertical-align:-.15em;border:1px solid #b4b4bb;background:repeating-linear-gradient(45deg,#ececef,#ececef 3px,#f8f8fa 3px,#f8f8fa 6px)}
.idml-flow table{border-collapse:collapse;margin:.5em 0}
.idml-flow td{border:1px solid #b4b4bb;padding:.25em .5em;vertical-align:top}
`

export interface IdmlFlow {
  /** A `<style>` and the document, ready to be a frame's body. Every piece of package text in it is escaped. */
  html: string
  /** Stories drawn. Zero: the package places no text this preview can read. */
  stories: number
}

/** `pageLabel` names a page in the reader's language ("Page 4"). */
export async function renderIdmlFlow(bytes: ArrayBuffer, pageLabel: (name: string) => string): Promise<IdmlFlow> {
  const zip = await JSZip.loadAsync(bytes)
  const read = async (path: string): Promise<Element | null> => {
    const text = await zip.file(path)?.async("string")
    return text ? parse(text) : null
  }
  const designmap = await read("designmap.xml")
  if (!designmap) throw new Error("IDML package has no readable designmap.xml")
  const sources = (tag: string): string[] =>
    kids(designmap).filter((k) => k.localName === tag).map((k) => k.getAttribute("src") ?? "").filter(Boolean)

  const palette = readPalette(await read("Resources/Graphic.xml"))
  const styles = readStyles(await read("Resources/Styles.xml"), palette)

  const stories = new Map<string, Element>()
  for (const path of sources("Story")) {
    const root = await read(path)
    const story = root ? (root.localName === "Story" && root.hasAttribute("Self") ? root : Array.from(root.getElementsByTagName("Story")).find((s) => s.hasAttribute("Self"))) : undefined
    const self = story?.getAttribute("Self")
    if (story && self) stories.set(self, story)
  }
  const spreads: Element[] = []
  for (const path of sources("Spread")) {
    const root = await read(path)
    if (root) spreads.push(root)
  }

  const order = [...placeStories(spreads).entries()]
    .filter(([id]) => stories.has(id))
    .sort((a, b) => comparePlacement(a[1], b[1]))
  const draw: Draw = { styles, stories, used: new Set(order.map(([id]) => id)) }
  let body = ""
  let drawn = 0
  let lastPage: string | null = null
  for (const [id, placement] of order) {
    const story = stories.get(id)!
    const blocks = drawBlocks(story, draw)
    if (!blocks) continue
    const mark = placement.pageName && placement.pageName !== lastPage
      ? `<div class="page-mark">${escapeHtml(pageLabel(placement.pageName))}</div>`
      : ""
    lastPage = placement.pageName ?? lastPage
    const direction = story.getElementsByTagName("StoryPreference")[0]?.getAttribute("StoryDirection")
    body += `<section class="story"${direction === "RightToLeftDirection" ? ' dir="rtl"' : ""}>${mark}${blocks}</section>`
    drawn++
  }
  return {
    html: `<style>${PAGE_CSS}${styles.cssText()}</style><div class="idml-flow">${body}</div>`,
    stories: drawn,
  }
}
