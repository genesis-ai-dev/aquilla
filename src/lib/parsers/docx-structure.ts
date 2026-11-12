// How a Word paragraph becomes a line, and back (AQU-2539).
//
// The DOCX importer (src/lib/parsers/docx.ts) and the DOCX exporter
// (src/lib/export/exporters/docx.ts) used to answer "which paragraph is this?"
// and "what is this paragraph's text?" each in its own way. The importer walked
// an element tree; the exporter matched paragraphs with a regex that cannot see
// a paragraph nested inside another one (a text box), so on a partner's file
// every translation after the first text box landed one paragraph late. This
// module is the single answer both sides use:
//
//   scanDocxParagraphs   every w:p in document order, nested ones included,
//                        numbered exactly as the importer's `w:p[N]` locators
//                        (it runs on xml-lite's own tokenizer), with where each
//                        one sits in the raw XML and whether it is a COPY.
//   walkDocxParagraph    a paragraph's OWN content (never a nested paragraph's),
//                        split into the pieces of its line and everything else.
//
// The baseline rules, applied the same way on import and on export:
//
//   1. A paragraph's line is its own visible text. A text box's paragraphs are
//      their own lines; their words never join the paragraph that holds the box.
//   2. `mc:AlternateContent` stores one drawing several times (a modern Choice
//      and an old-reader Fallback). Only its FIRST branch is read; a paragraph
//      in a later branch is a copy, makes no line, and on export receives the
//      translation of the paragraph at the same position in the first branch.
//   3. Tabs and manual line breaks between words are part of the line, as "\t"
//      and "\n". Footnote references are part of the line as USFM `\f … \f*`
//      markers. Everything else (pictures, page/column breaks, bookmarks, field
//      codes, comment anchors, hidden text) is not text: the exporter keeps it.
//
// DOM-free and JSZip-free: the importer half runs in the sync-worker too.

import {
  firstElementByTagName,
  getAttribute,
  isElement,
  scanXmlTags,
  startTagName,
  textContent,
  type XmlElement,
} from "./xml-lite"
import { createUsfmFootnoteMarker } from "../footnotes/insert"

// ── Paragraph scan ──────────────────────────────────────────────────────────

export interface DocxParagraphSpan {
  /** 1-based position among ALL w:p in document order — the N of `w:p[N]`. */
  index: number
  /** Offset of the paragraph's `<` in the scanned XML. */
  start: number
  /** Offset just past the paragraph's end tag (or its `/>`). */
  end: number
  selfClosing: boolean
  /** Index of the paragraph this one is nested in (a text box), or 0. */
  parent: number
  /** True when the paragraph sits in a later branch of mc:AlternateContent. */
  isCopy: boolean
  /** For a copy: the index of the paragraph it copies (always a non-copy), or
   *  0 when the branches do not line up and no pairing is safe. */
  copyOf: number
}

interface AlternateFrame {
  branches: number[][]
  /** Depth of open branch elements inside this frame (Choice/Fallback). */
  openBranch: number[] | null
}

const PARAGRAPH = "w:p"
const ALTERNATE = "mc:AlternateContent"
const BRANCHES = new Set(["mc:Choice", "mc:Fallback"])

/**
 * Every w:p of a WordprocessingML part, in document order, nested paragraphs
 * included. The numbering is the importer's `w:p[N]` (elementsByTagName order
 * over xml-lite's tree, which is start-tag order); both are built on
 * `scanXmlTags`, so they cannot disagree about what is a paragraph.
 */
export function scanDocxParagraphs(xml: string): DocxParagraphSpan[] {
  const spans: DocxParagraphSpan[] = []
  const openParagraphs: DocxParagraphSpan[] = []
  const frames: AlternateFrame[] = []
  const frameStack: AlternateFrame[] = []
  // Branch elements nest inside frames; track which frame a closing branch ends.
  const branchStack: AlternateFrame[] = []
  let copyDepth = 0

  scanXmlTags(xml, {
    open(body, start, end, selfClosing) {
      const name = startTagName(body)
      if (name === PARAGRAPH) {
        const span: DocxParagraphSpan = {
          index: spans.length + 1,
          start,
          end: selfClosing ? end : -1,
          selfClosing,
          parent: openParagraphs.length > 0 ? openParagraphs[openParagraphs.length - 1].index : 0,
          isCopy: copyDepth > 0,
          copyOf: 0,
        }
        spans.push(span)
        // A paragraph belongs to the current branch of EVERY open frame, so an
        // outer Choice/Fallback pairing also covers paragraphs nested deeper.
        for (const frame of frameStack) frame.openBranch?.push(span.index)
        if (!selfClosing) openParagraphs.push(span)
        return
      }
      if (name === ALTERNATE && !selfClosing) {
        const frame: AlternateFrame = { branches: [], openBranch: null }
        frames.push(frame)
        frameStack.push(frame)
        return
      }
      if (BRANCHES.has(name) && !selfClosing && frameStack.length > 0) {
        const frame = frameStack[frameStack.length - 1]
        const branch: number[] = []
        frame.branches.push(branch)
        frame.openBranch = branch
        branchStack.push(frame)
        if (frame.branches.length > 1) copyDepth++
      }
    },
    close(name, _start, end) {
      if (name === PARAGRAPH) {
        const span = openParagraphs.pop()
        if (span) span.end = end
        return
      }
      if (name === ALTERNATE) {
        frameStack.pop()
        return
      }
      if (BRANCHES.has(name) && branchStack.length > 0) {
        const frame = branchStack.pop()!
        if (frame.branches.length > 1) copyDepth--
        frame.openBranch = null
      }
    },
  })

  // Pair each later-branch paragraph with the first-branch paragraph at the
  // same position, when the branches hold the same number of paragraphs (they
  // do whenever Word wrote both: it is one text box stored twice). An outer
  // frame opens before the frames inside it, so walking the frames backwards
  // pairs inner frames first and lets the outer frame's pairing win.
  for (let f = frames.length - 1; f >= 0; f--) {
    const [first, ...rest] = frames[f].branches
    if (!first) continue
    for (const branch of rest) {
      if (branch.length !== first.length) continue
      for (let k = 0; k < branch.length; k++) spans[branch[k] - 1].copyOf = first[k]
    }
  }
  // A copy may point at a paragraph that is itself a copy (a text box inside a
  // Fallback that has its own AlternateContent); follow to the real one.
  for (const span of spans) {
    if (!span.isCopy) {
      span.copyOf = 0
      continue
    }
    let target = span.copyOf
    for (let guard = 0; target !== 0 && spans[target - 1].isCopy && guard < 64; guard++) {
      target = spans[target - 1].copyOf
    }
    span.copyOf = target !== 0 && !spans[target - 1].isCopy ? target : 0
  }
  return spans
}

// ── Paragraph walk ──────────────────────────────────────────────────────────

/** Inline marks a line carries (the editor's own mark names). */
export type DocxMark = "b" | "i" | "u" | "s"
export const DOCX_MARKS: readonly DocxMark[] = ["b", "i", "u", "s"]

/** One piece of a paragraph's own content. */
export type DocxPiece =
  /** Visible text: a `w:t`, or a `w:tab` ("\t"), `w:br` line break / `w:cr` ("\n"). */
  | { kind: "text"; text: string; source: "t" | "tab" | "break"; el: XmlElement; run: XmlElement; marks: ReadonlySet<DocxMark> }
  /** A run holding a w:footnoteReference. `marker` is the USFM span the line
   *  carries for it, or null when the note has no text (then it is just kept). */
  | { kind: "footnote"; id: string; marker: string | null; run: XmlElement }
  /** A whole element that carries no line text: kept as it is on export. */
  | { kind: "keep"; el: XmlElement }
  /** Non-text children of a run that ALSO holds text (a picture or page break
   *  in the same run as words): kept, re-wrapped in a run with the same look. */
  | { kind: "keepInRun"; run: XmlElement; children: XmlElement[] }
  /** A wrapper (hyperlink, simple field, content control, tracked insertion…)
   *  with its own pieces inside. */
  | { kind: "container"; el: XmlElement; items: DocxPiece[] }

/** Elements that wrap runs in a paragraph. Their runs are the paragraph's own. */
const CONTAINERS = new Set([
  "w:hyperlink",
  "w:fldSimple",
  "w:smartTag",
  "w:customXml",
  "w:sdt",
  "w:sdtContent",
  "w:ins",
  "w:moveTo",
  "w:dir",
  "w:bdo",
])

export interface DocxWalkContext {
  /** id → footnote text (word/footnotes.xml). */
  footnotes: ReadonlyMap<string, string>
  /** Is this run hidden (not shown or printed)? Default: never. */
  isHiddenRun?: (run: XmlElement, paragraph: XmlElement) => boolean
}

/** A paragraph's own content, in order. Nested paragraphs (text boxes) live
 *  inside `keep`/`keepInRun` pieces and are never walked into. */
export function walkDocxParagraph(p: XmlElement, ctx: DocxWalkContext): DocxPiece[] {
  return walkChildren(p, p, ctx)
}

function walkChildren(parent: XmlElement, p: XmlElement, ctx: DocxWalkContext): DocxPiece[] {
  const out: DocxPiece[] = []
  for (const child of parent.children) {
    if (!isElement(child)) continue
    if (child.tagName === "w:r") {
      walkRun(child, p, ctx, out)
    } else if (CONTAINERS.has(child.tagName)) {
      out.push({ kind: "container", el: child, items: walkChildren(child, p, ctx) })
    } else {
      out.push({ kind: "keep", el: child })
    }
  }
  return out
}

function walkRun(run: XmlElement, p: XmlElement, ctx: DocxWalkContext, out: DocxPiece[]): void {
  if (ctx.isHiddenRun?.(run, p)) {
    out.push({ kind: "keep", el: run })
    return
  }
  const ref = directChild(run, "w:footnoteReference")
  if (ref) {
    const id = getAttribute(ref, "w:id")
    const noteText = id !== null ? ctx.footnotes.get(id) : undefined
    out.push({
      kind: "footnote",
      id: id ?? "",
      marker: noteText ? createUsfmFootnoteMarker({ caller: "+", text: noteText }) : null,
      run,
    })
    return
  }

  const rPr = directChild(run, "w:rPr")
  const marks = marksOf(rPr)
  let pending: XmlElement[] = []
  const pieces: DocxPiece[] = []
  let hasText = false
  const flush = () => {
    if (pending.length > 0) pieces.push({ kind: "keepInRun", run, children: pending })
    pending = []
  }
  for (const child of run.children) {
    if (!isElement(child) || child.tagName === "w:rPr") continue
    const text = runChildText(child)
    if (text === null) {
      pending.push(child)
      continue
    }
    flush()
    hasText = true
    pieces.push({
      kind: "text",
      text: text.value,
      source: text.source,
      el: child,
      run,
      marks,
    })
  }
  if (!hasText) {
    // No text at all: the run is kept whole, byte for byte.
    out.push({ kind: "keep", el: run })
    return
  }
  flush()
  out.push(...pieces)
}

function runChildText(child: XmlElement): { value: string; source: "t" | "tab" | "break" } | null {
  switch (child.tagName) {
    case "w:t":
      return { value: textContent(child), source: "t" }
    case "w:tab":
      return { value: "\t", source: "tab" }
    case "w:cr":
      return { value: "\n", source: "break" }
    case "w:br": {
      const type = getAttribute(child, "w:type")
      // Page and column breaks are layout, not text.
      return type === null || type === "textWrapping" ? { value: "\n", source: "break" } : null
    }
    default:
      return null
  }
}

export function directChild(el: XmlElement, tagName: string): XmlElement | undefined {
  for (const child of el.children) {
    if (isElement(child) && child.tagName === tagName) return child
  }
  return undefined
}

const NO_MARKS: ReadonlySet<DocxMark> = new Set()

function marksOf(rPr: XmlElement | undefined): ReadonlySet<DocxMark> {
  if (rPr === undefined) return NO_MARKS
  const marks = new Set<DocxMark>()
  if (isToggleOn(rPr, "w:b")) marks.add("b")
  if (isToggleOn(rPr, "w:i")) marks.add("i")
  if (isUnderlineOn(rPr)) marks.add("u")
  if (isToggleOn(rPr, "w:strike")) marks.add("s")
  return marks.size === 0 ? NO_MARKS : marks
}

// AQU-1719: an OOXML toggle property is ON when it is present with no `w:val`,
// and OFF when `w:val` is `0`, `false` or `off` (ECMA-376 ST_OnOff). Google Docs
// exports write an explicit off flag for every toggle on every run
// (`<w:b w:val="0"/><w:i w:val="0"/><w:strike w:val="0"/><w:u w:val="none"/>`),
// so reading mere presence as "on" rendered unformatted source text as
// `<s><u><i><b>…`.
export function isToggleOn(rPr: XmlElement | undefined, tagName: string): boolean {
  if (rPr === undefined) return false
  const el = firstElementByTagName(rPr, tagName)
  if (el === undefined) return false
  return isOnOffValueTrue(getAttribute(el, "w:val"))
}

/** `w:val` is ST_OnOff: absent means on; `0`/`false`/`off` mean off. */
export function isOnOffValueTrue(val: string | null): boolean {
  if (val === null) return true
  const normalized = val.trim().toLowerCase()
  return normalized !== "0" && normalized !== "false" && normalized !== "off"
}

/** `w:u` carries ST_Underline, whose off value is `none` (not an ST_OnOff flag). */
function isUnderlineOn(rPr: XmlElement | undefined): boolean {
  if (rPr === undefined) return false
  const el = firstElementByTagName(rPr, "w:u")
  if (el === undefined) return false
  const val = getAttribute(el, "w:val")
  if (val !== null && val.trim().toLowerCase() === "none") return false
  return isOnOffValueTrue(val)
}

// ── The line ────────────────────────────────────────────────────────────────

/** One character run of the line, with the run it came from. */
export interface DocxLineChunk {
  text: string
  marks: ReadonlySet<DocxMark>
  /** The text piece it came from, or the footnote piece for a marker. */
  piece: Extract<DocxPiece, { kind: "text" } | { kind: "footnote" }>
}

export interface DocxLine {
  /** The line's text: own visible text, tabs and breaks between words,
   *  footnote markers. Empty when the paragraph has no visible words. */
  text: string
  /** The same text in chunks with their marks, in order. */
  chunks: DocxLineChunk[]
  /** True when some visible `w:t` holds a non-space character. A paragraph
   *  makes a line, and receives a translation on export, only then. */
  hasWords: boolean
}

/** Flatten a walked paragraph, containers opened, in document order. */
export function flattenPieces(items: readonly DocxPiece[]): Exclude<DocxPiece, { kind: "container" }>[] {
  const out: Exclude<DocxPiece, { kind: "container" }>[] = []
  const visit = (list: readonly DocxPiece[]) => {
    for (const item of list) {
      if (item.kind === "container") visit(item.items)
      else out.push(item)
    }
  }
  visit(items)
  return out
}

function isWord(piece: DocxPiece): boolean {
  return piece.kind === "text" && piece.source === "t" && piece.text.trim() !== ""
}

/**
 * Which flattened pieces belong to the line. Text from `w:t` always does
 * (leading/trailing spaces included, as before). A footnote with a marker
 * always does. A tab or line break does only when it sits between the first
 * and the last word: one before the first word or after the last stays where
 * it is in the paragraph, like any other non-text piece.
 */
export function linePieceFlags(flat: readonly DocxPiece[]): boolean[] {
  let first = -1
  let last = -1
  for (let k = 0; k < flat.length; k++) {
    if (isWord(flat[k])) {
      if (first === -1) first = k
      last = k
    }
  }
  return flat.map((piece, k) => {
    if (piece.kind === "footnote") return piece.marker !== null
    if (piece.kind !== "text") return false
    if (piece.source === "t") return true
    return first !== -1 && k > first && k < last
  })
}

/** The line a walked paragraph makes. */
export function docxLine(items: readonly DocxPiece[]): DocxLine {
  const flat = flattenPieces(items)
  const inLine = linePieceFlags(flat)
  const chunks: DocxLineChunk[] = []
  let text = ""
  let hasWords = false
  for (let k = 0; k < flat.length; k++) {
    if (!inLine[k]) continue
    const piece = flat[k]
    if (piece.kind === "text") {
      if (piece.text === "") continue
      if (isWord(piece)) hasWords = true
      chunks.push({ text: piece.text, marks: piece.marks, piece })
      text += piece.text
    } else if (piece.kind === "footnote" && piece.marker !== null) {
      chunks.push({ text: piece.marker, marks: NO_MARKS, piece })
      text += piece.marker
    }
  }
  return { text, chunks, hasWords }
}

// ── Hidden text (AQU-2539) ──────────────────────────────────────────────────
//
// The app imports what Word shows and prints. A run is hidden when its
// `w:vanish` is on — set on the run itself, or inherited through its character
// style, its paragraph's style, or the document defaults in word/styles.xml,
// each style followed up its `basedOn` chain. `w:val="0"/"false"/"off"` turns
// it off. A hidden run is never part of a line (walkRun keeps it whole), so a
// wholly hidden paragraph makes no line and the exporter never rewrites it.
//
// `w:vanish` is an ECMA-376 toggle property: direct formatting is absolute;
// from styles, the character style's value and the paragraph style's value
// are combined by exclusive-or (two "hidden" styles cancel), and the document
// default applies only when neither style says anything.

interface StyleEntry {
  basedOn: string | null
  /** The style's own w:vanish, or undefined when it does not set one. */
  vanish: boolean | undefined
}

export interface DocxStyleSheet {
  styles: ReadonlyMap<string, StyleEntry>
  defaultParagraphStyle: string | null
  defaultVanish: boolean
}

const EMPTY_STYLES: DocxStyleSheet = { styles: new Map(), defaultParagraphStyle: null, defaultVanish: false }

function vanishOf(rPr: XmlElement | undefined): boolean | undefined {
  if (rPr === undefined) return undefined
  const el = directChild(rPr, "w:vanish")
  return el === undefined ? undefined : isOnOffValueTrue(getAttribute(el, "w:val"))
}

/** Read the bits of word/styles.xml that decide whether text is hidden. */
export function readDocxStyleSheet(root: XmlElement | undefined): DocxStyleSheet {
  if (root === undefined) return EMPTY_STYLES
  const stylesEl = root.tagName === "w:styles" ? root : firstElementByTagName(root, "w:styles")
  if (stylesEl === undefined) return EMPTY_STYLES
  const styles = new Map<string, StyleEntry>()
  let defaultParagraphStyle: string | null = null
  let defaultVanish = false
  for (const child of stylesEl.children) {
    if (!isElement(child)) continue
    if (child.tagName === "w:docDefaults") {
      const rPrDefault = directChild(child, "w:rPrDefault")
      defaultVanish = vanishOf(rPrDefault ? directChild(rPrDefault, "w:rPr") : undefined) ?? false
      continue
    }
    if (child.tagName !== "w:style") continue
    const id = getAttribute(child, "w:styleId")
    if (id === null) continue
    const basedOn = directChild(child, "w:basedOn")
    styles.set(id, {
      basedOn: basedOn ? getAttribute(basedOn, "w:val") : null,
      vanish: vanishOf(directChild(child, "w:rPr")),
    })
    const isDefault = getAttribute(child, "w:default")
    if (getAttribute(child, "w:type") === "paragraph" && isDefault !== null && isOnOffValueTrue(isDefault)) {
      defaultParagraphStyle = id
    }
  }
  return { styles, defaultParagraphStyle, defaultVanish }
}

/** A style's w:vanish, followed up its basedOn chain; undefined if none sets it. */
function styleVanish(sheet: DocxStyleSheet, styleId: string | null): boolean | undefined {
  const seen = new Set<string>()
  let id = styleId
  while (id !== null && !seen.has(id)) {
    seen.add(id)
    const entry = sheet.styles.get(id)
    if (entry === undefined) return undefined
    if (entry.vanish !== undefined) return entry.vanish
    id = entry.basedOn
  }
  return undefined
}

/** The `isHiddenRun` a walk needs, for one document's style sheet. */
export function hiddenRunTest(sheet: DocxStyleSheet): (run: XmlElement, paragraph: XmlElement) => boolean {
  const paragraphStyleOf = (p: XmlElement): string | null => {
    const pPr = directChild(p, "w:pPr")
    const pStyle = pPr ? directChild(pPr, "w:pStyle") : undefined
    return pStyle ? getAttribute(pStyle, "w:val") : sheet.defaultParagraphStyle
  }
  return (run, p) => {
    const rPr = directChild(run, "w:rPr")
    const direct = vanishOf(rPr)
    if (direct !== undefined) return direct
    const rStyle = rPr ? directChild(rPr, "w:rStyle") : undefined
    const fromCharacter = styleVanish(sheet, rStyle ? getAttribute(rStyle, "w:val") : null)
    const fromParagraph = styleVanish(sheet, paragraphStyleOf(p))
    if (fromCharacter === undefined && fromParagraph === undefined) return sheet.defaultVanish
    return (fromCharacter ?? false) !== (fromParagraph ?? false)
  }
}
