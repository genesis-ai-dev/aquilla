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
// A look stretch is one look only; one whose edge falls inside a word grows to
// the whole word, so "4QSamᵃ" or a Hebrew word whose points sit in their own
// runs is looked for as that word, each character written back in its own
// look. A stretch of several words that is not found is opened up into its
// words, each looked for in turn, as a link or field that is not found is
// opened up. A stretch counts when it holds a letter or digit and is not a
// lone Latin letter or digit (an italic "a" alone would grab the French "a").

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
  /** A wrapper whose text was not found (a simple field, a content control,
   *  a tracked insertion…): kept with its own tags, emptied of its text. */
  | { kind: "emptyField"; piece: ContainerPiece; children: RNode[] }
  /** A field whose result was not found: its code kept as one unit with an
   *  empty result, so it closes before or after the translation, never
   *  around it. */
  | { kind: "emptied"; nodes: RNode[] }

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
  /** Each footnote reference written at a marker, with that marker's text. */
  footnotes: { id: string; marker: string }[]
  /** Footnote markers in the translation with no reference in the source
   *  paragraph to put there (a note the translator added): not written. */
  unplacedMarkers: number
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
  const result: RebuildResult = {
    xml: "", keptLooks: 0, keptFields: 0, keptLinks: 0, emptiedFields: 0, droppedLinks: 0, footnotes: [],
    unplacedMarkers: 0,
  }

  // Footnote markers in the translation, and the reference runs they take.
  const markers = [...input.text.matchAll(FOOTNOTE_SPAN_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }))
  let masked = input.text
  for (const m of markers) {
    masked = masked.slice(0, m.start) + TRANSLATION_FOOTNOTE.repeat(m.end - m.start) + masked.slice(m.end)
  }
  const written = input.writtenText ?? input.text

  let nodes = buildNodes(input.items, input.lineSet)
  const refRuns: string[] = []
  const refIds: string[] = []
  collectMarkers(nodes, (piece) => {
    refRuns.push(io.elementXml(piece.run))
    refIds.push(piece.id)
  })

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
        const tag = node.piece.el.tagName
        if (!holdsText(node)) {
          // Nothing of it is translated (a picture content control, an
          // insertion around a picture): kept as it is.
          next.push({ kind: "keep", piece: { kind: "keep", el: node.piece.el } })
        } else if (tag === "w:hyperlink") {
          // A link whose words changed: the link goes, its words stay.
          result.droppedLinks++
          next.push(...node.children)
        } else {
          if (tag === "w:fldSimple") result.emptiedFields++
          next.push({ kind: "emptyField", piece: node.piece, children: node.children })
        }
      } else if (node.kind === "field") {
        changed = true
        if (node.result.some(holdsText)) result.emptiedFields++
        next.push({ kind: "emptied", nodes: [...node.open, ...node.result, node.close] })
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
        if (usedRefs < refRuns.length) {
          result.footnotes.push({ id: refIds[usedRefs], marker: input.text.slice(marker.start, marker.end) })
          stream += refRuns[usedRefs++]
        }
        k = marker.end
        continue
      }
      const next = Math.min(to, markers.find((m) => m.start > k)?.start ?? to)
      stream += runsByLook(written, k, next, (i) => lookFor(input, input.marks[i] ?? new Set()))
      k = next
    }
  }
  for (const [node, match] of ordered) {
    let start = match.start
    let end = match.end
    if (node.kind === "wrapper" || node.kind === "field") {
      // The frame is copied with its own edge spaces; the translation's spaces
      // next to it are not written a second time.
      const text = textOf(node)
      const lead = text.length - text.trimStart().length
      const trail = text.length - text.trimEnd().length
      for (let n = 0; n < lead && start > cursor && /\s/.test(input.text[start - 1]); n++) start--
      for (let n = 0; n < trail && end < input.text.length && /\s/.test(input.text[end]); n++) end++
    }
    plain(cursor, start)
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
    cursor = end
  }
  plain(cursor, input.text.length)
  result.unplacedMarkers = Math.max(0, markers.length - refRuns.length)

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
    case "emptied":
      return node.nodes.some(holdsWord)
    default:
      return false
  }
}

/** Does this node hold any of the line (text or a footnote marker)? */
function holdsText(node: RNode): boolean {
  switch (node.kind) {
    case "text":
    case "marker":
      return true
    case "wrapper":
    case "emptyField":
      return node.children.some(holdsText)
    case "field":
      return node.result.some(holdsText)
    case "emptied":
      return node.nodes.some(holdsText)
    default:
      return false
  }
}

function collectMarkers(nodes: readonly RNode[], visit: (piece: FootnotePiece) => void): void {
  for (const node of nodes) {
    if (node.kind === "marker") visit(node.piece)
    else if (node.kind === "wrapper" || node.kind === "emptyField") collectMarkers(node.children, visit)
    else if (node.kind === "field") collectMarkers(node.result, visit)
    else if (node.kind === "emptied") collectMarkers(node.nodes, visit)
  }
}

// ── Matching ────────────────────────────────────────────────────────────────

interface Match {
  start: number
  end: number
  /** For a look stretch: the source look of each character. */
  looks?: string[]
}

interface LookAnchor {
  order: number
  needle: string
  /** The source look of each character of `needle`. */
  looks: string[]
}

interface Anchor {
  node: RNode
  order: number
  needle: string
  /** For a look stretch: the source look of each character. */
  looks?: string[]
  /** For a look stretch: its words without their edge punctuation, looked
   *  for in order when the whole stretch is not in the translation (it is
   *  opened up, like a link or field that is not found). */
  words?: LookAnchor[]
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
/** One Latin letter or digit and nothing else: in its own look (an italic
 *  "a", a superscript "3") it is a different word in the translation more
 *  often than not, so it is only ever kept as part of its word. */
const LONE_LATIN = /^[A-Za-z0-9]$/

/** The guard against silly matches (see the header): a look stretch counts
 *  when it holds a letter or digit and is not a lone Latin letter or digit. */
export function anchorCounts(needle: string): boolean {
  return HAS_LETTER_OR_DIGIT.test(needle) && !LONE_LATIN.test(needle)
}

function trimmed(text: string): { lead: number; text: string } {
  const lead = text.length - text.trimStart().length
  return { lead, text: text.trim() }
}

function anchorsOf(nodes: readonly RNode[], baseRpr: string, io: RebuildIo): Anchor[] {
  const anchors: Anchor[] = []
  let offset = 0
  // Look stretches: runs of the line's own characters in ONE look other than
  // the base look. A stretch whose edge falls inside a word grows to that whole
  // word (stretches meeting in one word become one), so a superscript letter
  // or a Hebrew vowel point is only ever looked for as part of its word. A
  // frame or a footnote ends a stretch.
  let chars: { ch: string; look: string; special: boolean; at: number }[] = []
  let owner: RNode[] = []
  const flushStretches = () => {
    const isWordAt = (i: number) => i >= 0 && i < chars.length && WORD_CHAR.test(chars[i].ch)
    const units: { start: number; end: number }[] = []
    for (let k = 0; k < chars.length;) {
      if (!chars[k].special) {
        k++
        continue
      }
      let end = k + 1
      while (end < chars.length && chars[end].special && chars[end].look === chars[k].look) end++
      let start = k
      while (isWordAt(start - 1) && isWordAt(start)) start--
      let grown = end
      while (isWordAt(grown) && isWordAt(grown - 1)) grown++
      const last = units[units.length - 1]
      if (last && start < last.end) last.end = Math.max(last.end, grown)
      else units.push({ start, end: grown })
      k = end
    }
    for (const unit of units) {
      const slice = chars.slice(unit.start, unit.end)
      const part = (from: number, to: number): LookAnchor | null => {
        const raw = slice.slice(from, to).map((c) => c.ch).join("")
        const { lead, text } = trimmed(raw)
        if (!anchorCounts(text)) return null
        return {
          order: slice[from + lead].at,
          needle: text,
          looks: slice.slice(from + lead, from + lead + text.length).map((c) => c.look),
        }
      }
      // Its words, for when the whole unit is not in the translation: each
      // without the punctuation at its edges (the French «⍽mot⍽» for “word”,
      // "mot⍽:" for "word:"); punctuation inside a word stays ("6.3.3").
      const words: LookAnchor[] = []
      const isWordChar = (k: number) => WORD_CHAR.test(slice[k].ch)
      for (let k = 0; k < slice.length;) {
        if (/\s/.test(slice[k].ch)) {
          k++
          continue
        }
        let end = k
        while (end < slice.length && !/\s/.test(slice[end].ch)) end++
        let from = k
        let to = end
        while (from < to && !isWordChar(from)) from++
        while (to > from && !isWordChar(to - 1)) to--
        const word = part(from, to)
        if (word) words.push(word)
        k = end
      }
      const whole = part(0, slice.length)
      const openedUp = words.length === 1 && whole?.needle === words[0].needle ? [] : words
      if (whole) anchors.push({ node: owner[unit.start], ...whole, words: openedUp })
      else for (const word of words) anchors.push({ node: owner[unit.start], ...word, words: [] })
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
      // A field or link is found by its whole visible text, however short
      // (a caption's number "1"): its own structure is the anchor.
      if (HAS_LETTER_OR_DIGIT.test(needle) && !needle.includes(SOURCE_FOOTNOTE)) {
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
    if (at !== -1) {
      const match = { start: at, end: at + anchor.needle.length, ...(anchor.looks ? { looks: anchor.looks } : {}) }
      if (anchor.looks) lookMatches.push(match)
      else out.set(anchor.node, match)
      cursor = match.end
      continue
    }
    // Not found whole: open it up into its words.
    for (const word of anchor.words ?? []) {
      const wordAt = findWhole(masked, word.needle, cursor)
      if (wordAt === -1) continue
      lookMatches.push({ start: wordAt, end: wordAt + word.needle.length, looks: word.looks })
      cursor = wordAt + word.needle.length
    }
  }
  // Look stretches are keyed by synthetic nodes so one text node may hold several.
  for (const match of lookMatches) out.set({ kind: "keep", piece: { kind: "keep", el: LOOK_MARK } } as RNode, match)
  return out
}

/** A placeholder element for look-stretch matches (they own no source element). */
const LOOK_MARK: XmlElement = { tagName: "#look", attributes: {}, children: [] }

/** The whole character (code point) ending just before `index`, or "". */
function charBefore(text: string, index: number): string {
  if (index <= 0) return ""
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return text.slice(index - 2, index)
  return text[index - 1]
}

/** The whole character (code point) starting at `index`, or "". */
function charAt(text: string, index: number): string {
  const code = text.codePointAt(index)
  return code === undefined ? "" : String.fromCodePoint(code)
}

/** First whole-word occurrence of `needle` in `hay` at or after `from`. */
function findWhole(hay: string, needle: string, from: number): number {
  const first = charAt(needle, 0)
  const last = charBefore(needle, needle.length)
  let at = hay.indexOf(needle, from)
  while (at !== -1) {
    const okStart = !WORD_CHAR.test(first) || !WORD_CHAR.test(charBefore(hay, at))
    const okEnd = !WORD_CHAR.test(last) || !WORD_CHAR.test(charAt(hay, at + needle.length))
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
      case "emptied":
        visitNonText(node)
        return
      default:
        return
    }
  }
  // Everything but the text, wrappers keeping their own tags.
  const visitNonText = (node: RNode): void => {
    switch (node.kind) {
      case "keep":
        visit(node)
        return
      case "wrapper":
      case "emptyField":
        close()
        out += io.openTag(node.piece.el)
        node.children.forEach(visitNonText)
        close()
        out += io.closeTag(node.piece.el)
        return
      case "field":
        ;[...node.open, ...node.result, node.close].forEach(visitNonText)
        return
      case "emptied":
        node.nodes.forEach(visitNonText)
        return
      default:
        // Text goes to the translation; a footnote marker's reference run is
        // written where the translation puts the marker.
        return
    }
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
      case "emptied":
        node.nodes.forEach(visit)
        return
    }
  }
  nodes.forEach(visit)
  return out
}
