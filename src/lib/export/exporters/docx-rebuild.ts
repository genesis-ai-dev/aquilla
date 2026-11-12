// Rebuilding one translated Word paragraph (AQU-2539).
//
// The exporter (docx.ts) hands over the paragraph's walked pieces (the shared
// walker in src/lib/parsers/docx-structure.ts), which of them are the line,
// and the translation. Two rules place everything:
//
//   PLACEMENT. Everything in the paragraph that is not text (bookmarks, field
//   codes, pictures, page breaks, hidden runs, comment anchors) is copied byte
//   for byte. What comes before the paragraph's first word stays in front of
//   the translation; the rest follows it, in its original order. A footnote
//   reference goes where its USFM marker sits in the translation.
//
//   UNCHANGED TEXT KEEPS WHAT IT HAD. A stretch of the source that carries
//   more than plain text — its own run look (Greek or Hebrew words, sigla), a
//   field (a caption number, a page reference), a link — is looked for in the
//   translation, as whole words, in source order. Where the translation has
//   the same text, that stretch is written exactly as the source had it: the
//   field or link copied byte for byte around it, or its own `w:rPr`. Where it
//   does not, a look falls back to the paragraph's base look, a link is
//   dropped (its words stay), and a field keeps its code with an empty result
//   that Word fills in on "Update field".
//
// A stretch counts when it holds a letter or digit and is at least 3
// characters long, or has no Latin letters at all (so "a" or "th" in another
// look never grab a word of the translation, while "א" or "66" do).

import { isElement, type XmlElement } from "@/lib/parsers/xml-lite"
import type { DocxPiece } from "@/lib/parsers/docx-structure"
import { rPrWithMarks, textRunXml, type Mark } from "./docx-runs"

type Leaf = Exclude<DocxPiece, { kind: "container" }>
type TextPiece = Extract<DocxPiece, { kind: "text" }>
type FootnotePiece = Extract<DocxPiece, { kind: "footnote" }>
type ContainerPiece = Extract<DocxPiece, { kind: "container" }>

type RNode =
  | { kind: "text"; piece: TextPiece }
  | { kind: "marker"; piece: FootnotePiece }
  | { kind: "keep"; piece: Leaf }
  | { kind: "wrapper"; piece: ContainerPiece; children: RNode[] }
  | { kind: "field"; open: RNode[]; result: RNode[]; close: RNode }
  /** A simple field whose result was not found: kept, emptied of its text. */
  | { kind: "emptyField"; piece: ContainerPiece; children: RNode[] }

export interface RebuildIo {
  /** The source bytes of an element, nested paragraphs rendered. */
  elementXml(el: XmlElement): string
  /** An element's start tag / end tag, verbatim. */
  openTag(el: XmlElement): string
  closeTag(el: XmlElement): string
  /** A run's `<w:rPr>…</w:rPr>`, verbatim, or "". */
  rPrXml(run: XmlElement): string
}

export interface RebuildInput {
  /** The pieces of the element the translation is written into. */
  items: readonly DocxPiece[]
  lineSet: ReadonlySet<DocxPiece>
  /** The translation, one mark set per character. */
  text: string
  marks: readonly ReadonlySet<Mark>[]
  /** The translation as written into the file (same length as `text`):
   *  where language rules swap one character for another. */
  writtenText?: string
  /** The base run look, "" for none. */
  baseRpr: string
  /** A translated stretch with exactly these marks takes this source look. */
  markLooks: ReadonlyMap<string, string>
  /** Applied to every run look of TRANSLATED text (not to unchanged stretches). */
  translatedLook?: (rPr: string) => string
  io: RebuildIo
}

export interface RebuildResult {
  xml: string
  /** Stretches of the source found unchanged in the translation. */
  keptLooks: number
  keptFields: number
  keptLinks: number
  /** Fields written with an empty result, links dropped. */
  emptiedFields: number
  droppedLinks: number
}

const FOOTNOTE_SPAN_RE = /\\f\s+[^\s\\]+[\s\S]*?\\f\*/g
/** Stands for a footnote in source text, so a stretch holding one never matches. */
const SOURCE_FOOTNOTE = "￼"
/** Stands for a footnote in the translation while it is searched. */
const TRANSLATION_FOOTNOTE = "�"

export const markKey = (marks: ReadonlySet<Mark>): string =>
  [...marks].filter((m) => m !== "code").sort().join("+")

export function rebuildParagraphInner(input: RebuildInput): RebuildResult {
  const { io } = input
  const result: RebuildResult = { xml: "", keptLooks: 0, keptFields: 0, keptLinks: 0, emptiedFields: 0, droppedLinks: 0 }

  // Footnote markers in the translation, and the reference runs they take.
  const markers = [...input.text.matchAll(FOOTNOTE_SPAN_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }))
  let masked = input.text
  for (const m of markers) {
    masked = masked.slice(0, m.start) + TRANSLATION_FOOTNOTE.repeat(m.end - m.start) + masked.slice(m.end)
  }
  const written = input.writtenText ?? input.text

  let nodes = buildNodes(input.items, input.lineSet)
  const refRuns: string[] = []
  collectMarkers(nodes, (piece) => refRuns.push(io.elementXml(piece.run)))

  // Match, then open up what did not match, until nothing changes.
  let matches: Map<RNode, Match>
  for (;;) {
    matches = matchAnchors(nodes, masked, input.baseRpr, io)
    let changed = false
    const next: RNode[] = []
    for (const node of nodes) {
      if (matches.has(node)) {
        next.push(node)
        continue
      }
      if (node.kind === "wrapper") {
        changed = true
        if (node.piece.el.tagName === "w:fldSimple") {
          result.emptiedFields++
          next.push({ kind: "emptyField", piece: node.piece, children: node.children })
        } else {
          if (node.piece.el.tagName === "w:hyperlink") result.droppedLinks++
          next.push(...node.children)
        }
      } else if (node.kind === "field") {
        changed = true
        result.emptiedFields++
        next.push(...node.open, ...node.result, node.close)
      } else {
        next.push(node)
      }
    }
    nodes = next
    if (!changed) break
  }

  // Placement: front / translation / back.
  const firstWord = nodes.findIndex((node) => holdsWord(node))
  const front: RNode[] = []
  const back: RNode[] = []
  nodes.forEach((node, k) => {
    if (node.kind === "text" || node.kind === "marker" || matches.has(node)) return
    ;(firstWord === -1 || k <= firstWord ? front : back).push(node)
  })

  // The translation, with matched stretches written as the source had them.
  const ordered = [...matches.entries()].sort((a, b) => a[1].start - b[1].start)
  let stream = ""
  let cursor = 0
  let usedRefs = 0
  const plain = (from: number, to: number) => {
    let k = from
    while (k < to) {
      const marker = markers.find((m) => m.start === k)
      if (marker) {
        if (usedRefs < refRuns.length) stream += refRuns[usedRefs++]
        k = marker.end
        continue
      }
      const next = Math.min(to, markers.find((m) => m.start > k)?.start ?? to)
      stream += runsByLook(written, k, next, (i) => lookFor(input, input.marks[i] ?? new Set()))
      k = next
    }
  }
  for (const [node, match] of ordered) {
    plain(cursor, match.start)
    if (node.kind === "wrapper" || node.kind === "field") {
      stream += renderVerbatim(node.kind === "wrapper" ? [node] : [...node.open, ...node.result, node.close], io)
      if (node.kind === "field") result.keptFields++
      else if (node.piece.el.tagName === "w:hyperlink") result.keptLinks++
      else if (node.piece.el.tagName === "w:fldSimple") result.keptFields++
    } else {
      const looks = match.looks!
      stream += runsByLook(input.text, match.start, match.end, (i) => looks[i - match.start])
      result.keptLooks++
    }
    cursor = match.end
  }
  plain(cursor, input.text.length)

  result.xml = renderLeaves(front, io) + stream + refRuns.slice(usedRefs).join("") + renderLeaves(back, io)
  return result
}

function lookFor(input: RebuildInput, marks: ReadonlySet<Mark>): string {
  const key = markKey(marks)
  const look = key === ""
    ? input.baseRpr
    : input.markLooks.get(key) ?? rPrWithMarks(input.baseRpr || null, marks)
  return input.translatedLook ? input.translatedLook(look) : look
}

/** Runs for text[from, to), one per change of look. */
function runsByLook(text: string, from: number, to: number, lookAt: (i: number) => string): string {
  let out = ""
  let start = from
  for (let i = from + 1; i <= to; i++) {
    if (i === to || lookAt(i) !== lookAt(start)) {
      out += textRunXml(text.slice(start, i), lookAt(start))
      start = i
    }
  }
  return out
}

// ── Nodes ───────────────────────────────────────────────────────────────────

function buildNodes(items: readonly DocxPiece[], lineSet: ReadonlySet<DocxPiece>): RNode[] {
  const nodes = items.map((item): RNode => {
    if (item.kind === "container") return { kind: "wrapper", piece: item, children: buildNodes(item.items, lineSet) }
    if (lineSet.has(item)) {
      if (item.kind === "footnote") return { kind: "marker", piece: item }
      if (item.kind === "text") return { kind: "text", piece: item }
    }
    return { kind: "keep", piece: item }
  })
  return foldFields(nodes)
}

function fieldCharOf(node: RNode): string | null {
  if (node.kind !== "keep") return null
  const piece = node.piece
  const children = piece.kind === "keep" && piece.el.tagName === "w:r"
    ? piece.el.children
    : piece.kind === "keepInRun" ? piece.children : []
  for (const child of children) {
    if (isElement(child) && child.tagName === "w:fldChar") return child.attributes["w:fldCharType"] ?? null
  }
  return null
}

/** Group begin … separate … end runs into fields (innermost first). A field
 *  that starts or ends in another paragraph stays as loose pieces. */
function foldFields(nodes: RNode[]): RNode[] {
  const root: RNode[] = []
  const stack: { nodes: RNode[]; sep: number }[] = []
  const top = () => (stack.length > 0 ? stack[stack.length - 1].nodes : root)
  for (const node of nodes) {
    const fc = fieldCharOf(node)
    if (fc === "begin") {
      stack.push({ nodes: [node], sep: -1 })
      continue
    }
    if (fc === "separate" && stack.length > 0 && stack[stack.length - 1].sep === -1) {
      const frame = stack[stack.length - 1]
      frame.nodes.push(node)
      frame.sep = frame.nodes.length - 1
      continue
    }
    if (fc === "end" && stack.length > 0) {
      const frame = stack.pop()!
      frame.nodes.push(node)
      if (frame.sep >= 0) {
        top().push({ kind: "field", open: frame.nodes.slice(0, frame.sep + 1), result: frame.nodes.slice(frame.sep + 1, -1), close: node })
      } else {
        top().push(...frame.nodes)
      }
      continue
    }
    top().push(node)
  }
  while (stack.length > 0) {
    const frame = stack.pop()!
    top().push(...frame.nodes)
  }
  return root
}

function textOf(node: RNode): string {
  switch (node.kind) {
    case "text":
      return node.piece.text
    case "marker":
      return SOURCE_FOOTNOTE
    case "wrapper":
      return node.children.map(textOf).join("")
    case "field":
      return node.result.map(textOf).join("")
    default:
      return ""
  }
}

function holdsWord(node: RNode): boolean {
  switch (node.kind) {
    case "text":
      return node.piece.source === "t" && node.piece.text.trim() !== ""
    case "wrapper":
    case "emptyField":
      return node.children.some(holdsWord)
    case "field":
      return node.result.some(holdsWord)
    default:
      return false
  }
}

function collectMarkers(nodes: readonly RNode[], visit: (piece: FootnotePiece) => void): void {
  for (const node of nodes) {
    if (node.kind === "marker") visit(node.piece)
    else if (node.kind === "wrapper" || node.kind === "emptyField") collectMarkers(node.children, visit)
    else if (node.kind === "field") collectMarkers(node.result, visit)
  }
}

// ── Matching ────────────────────────────────────────────────────────────────

interface Match {
  start: number
  end: number
  /** For a look stretch: the source look of each character. */
  looks?: string[]
}

interface Anchor {
  node: RNode
  order: number
  needle: string
  looks?: string[]
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const LATIN_LETTER = /[A-Za-z]/

/** The guard against silly matches (see the header). */
export function anchorCounts(needle: string): boolean {
  return HAS_LETTER_OR_DIGIT.test(needle) && (needle.length >= 3 || !LATIN_LETTER.test(needle))
}

function trimmed(text: string): { lead: number; text: string } {
  const lead = text.length - text.trimStart().length
  return { lead, text: text.trim() }
}

function anchorsOf(nodes: readonly RNode[], baseRpr: string, io: RebuildIo): Anchor[] {
  const anchors: Anchor[] = []
  let offset = 0
  // Look stretches: characters of the line's own text whose look is not the
  // base look, joined across spaces; a frame or a footnote ends a stretch.
  let chars: { ch: string; look: string; special: boolean; at: number }[] = []
  let owner: RNode[] = []
  const flushStretches = () => {
    let k = 0
    while (k < chars.length) {
      if (!chars[k].special) {
        k++
        continue
      }
      let end = k + 1
      for (;;) {
        while (end < chars.length && chars[end].special) end++
        let gap = end
        while (gap < chars.length && !chars[gap].special && /\s/.test(chars[gap].ch)) gap++
        if (gap > end && gap < chars.length && chars[gap].special) {
          end = gap
          continue
        }
        break
      }
      const slice = chars.slice(k, end)
      const raw = slice.map((c) => c.ch).join("")
      const { lead, text } = trimmed(raw)
      if (anchorCounts(text)) {
        anchors.push({
          node: owner[k],
          order: slice[lead].at,
          needle: text,
          looks: slice.slice(lead, lead + text.length).map((c) => c.look),
        })
      }
      k = end
    }
    chars = []
    owner = []
  }
  for (const node of nodes) {
    if (node.kind === "text") {
      const look = io.rPrXml(node.piece.run)
      // UTF-16 units, the unit of every offset here.
      const text = node.piece.text
      for (let i = 0; i < text.length; i++) {
        chars.push({ ch: text[i], look, special: look !== baseRpr, at: offset })
        owner.push(node)
        offset++
      }
      continue
    }
    if (node.kind === "keep") continue
    flushStretches()
    const text = textOf(node)
    if (node.kind === "wrapper" || node.kind === "field") {
      const { lead, text: needle } = trimmed(text)
      if (anchorCounts(needle) && !needle.includes(SOURCE_FOOTNOTE)) {
        anchors.push({ node, order: offset + lead, needle })
      }
    }
    offset += text.length
  }
  flushStretches()
  return anchors.sort((a, b) => a.order - b.order)
}

function matchAnchors(nodes: readonly RNode[], masked: string, baseRpr: string, io: RebuildIo): Map<RNode, Match> {
  const out = new Map<RNode, Match>()
  const lookMatches: Match[] = []
  let cursor = 0
  for (const anchor of anchorsOf(nodes, baseRpr, io)) {
    // A look stretch's node may carry several stretches; frames carry one.
    if (anchor.looks === undefined && out.has(anchor.node)) continue
    const at = findWhole(masked, anchor.needle, cursor)
    if (at === -1) continue
    const match = { start: at, end: at + anchor.needle.length, ...(anchor.looks ? { looks: anchor.looks } : {}) }
    if (anchor.looks) lookMatches.push(match)
    else out.set(anchor.node, match)
    cursor = match.end
  }
  // Look stretches are keyed by synthetic nodes so one text node may hold several.
  for (const match of lookMatches) out.set({ kind: "keep", piece: { kind: "keep", el: LOOK_MARK } } as RNode, match)
  return out
}

/** A placeholder element for look-stretch matches (they own no source element). */
const LOOK_MARK: XmlElement = { tagName: "#look", attributes: {}, children: [] }

/** First whole-word occurrence of `needle` in `hay` at or after `from`. */
function findWhole(hay: string, needle: string, from: number): number {
  let at = hay.indexOf(needle, from)
  while (at !== -1) {
    const before = at > 0 ? hay[at - 1] : ""
    const after = hay[at + needle.length] ?? ""
    const okStart = !WORD_CHAR.test(needle[0]) || !WORD_CHAR.test(before)
    const okEnd = !WORD_CHAR.test(needle[needle.length - 1]) || !WORD_CHAR.test(after)
    if (okStart && okEnd) return at
    at = hay.indexOf(needle, at + 1)
  }
  return -1
}

// ── Rendering source pieces ─────────────────────────────────────────────────

/** Non-text pieces in order; non-text children of one run stay in one run. */
function renderLeaves(nodes: readonly RNode[], io: RebuildIo): string {
  let out = ""
  let open: { run: XmlElement; xml: string } | null = null
  const close = () => {
    if (open) out += `${open.xml}</w:r>`
    open = null
  }
  const inRun = (run: XmlElement, children: readonly XmlElement[]) => {
    if (!open || open.run !== run) {
      close()
      open = { run, xml: io.openTag(run) + io.rPrXml(run) }
    }
    for (const child of children) open.xml += io.elementXml(child)
  }
  const visit = (node: RNode) => {
    switch (node.kind) {
      case "keep": {
        const piece = node.piece
        if (piece.kind === "keepInRun") inRun(piece.run, piece.children)
        else if (piece.kind === "text") inRun(piece.run, [piece.el])
        else if (piece.kind === "keep") {
          if (piece.el === LOOK_MARK) return
          close()
          out += io.elementXml(piece.el)
        } else if (piece.kind === "footnote") {
          close()
          out += io.elementXml(piece.run)
        }
        return
      }
      case "emptyField":
        close()
        out += io.openTag(node.piece.el)
        node.children.forEach(visitNonText)
        close()
        out += io.closeTag(node.piece.el)
        return
      default:
        return
    }
  }
  // Inside an emptied field: everything but its text.
  const visitNonText = (node: RNode) => {
    if (node.kind === "keep") visit(node)
    else if (node.kind === "wrapper" || node.kind === "emptyField") node.children.forEach(visitNonText)
    else if (node.kind === "field") [...node.open, ...node.result, node.close].forEach(visitNonText)
  }
  nodes.forEach(visit)
  close()
  return out
}

/** A matched frame, byte for byte: each source element it is made of, once. */
function renderVerbatim(nodes: readonly RNode[], io: RebuildIo): string {
  let out = ""
  let last: XmlElement | null = null
  const emit = (el: XmlElement) => {
    if (el === last) return
    last = el
    out += io.elementXml(el)
  }
  const visit = (node: RNode) => {
    switch (node.kind) {
      case "text":
        emit(node.piece.run)
        return
      case "marker":
        emit(node.piece.run)
        return
      case "keep": {
        const piece = node.piece
        emit(piece.kind === "keep" ? piece.el : piece.run)
        return
      }
      case "wrapper":
      case "emptyField":
        emit(node.piece.el)
        return
      case "field":
        ;[...node.open, ...node.result, node.close].forEach(visit)
        return
    }
  }
  nodes.forEach(visit)
  return out
}
