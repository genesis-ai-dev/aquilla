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
import { directRprChild, rPrWithMarks, textRunXml, type Mark } from "./docx-runs"

type Leaf = Exclude<DocxPiece, { kind: "container" }>
type TextPiece = Extract<DocxPiece, { kind: "text" }>
type FootnotePiece = Extract<DocxPiece, { kind: "footnote" }>
type ContainerPiece = Extract<DocxPiece, { kind: "container" }>

type RNode =
  | { kind: "text"; piece: TextPiece }
  | { kind: "marker"; piece: FootnotePiece }
  | { kind: "keep"; piece: Leaf }
  /** `partial`: it lost some of what it held to a hidden or deleted line, so
   *  it is never copied byte for byte (see `withoutLost`). */
  | { kind: "wrapper"; piece: ContainerPiece; children: RNode[]; partial?: true }
  | { kind: "field"; open: RNode[]; result: RNode[]; close: RNode; partial?: true }
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
  /** Applied to every run look of TRANSLATED text (not to unchanged stretches). */
  translatedLook?: (rPr: string) => string
  /** Per character: the source look to write it in, for a line with no
   *  translation written as its source (AQU-2539); undefined for translated
   *  text. */
  sourceLooks?: readonly (string | undefined)[]
  /** AQU-2552 (review r6): for a paragraph cut into lines, the line each
   *  character of `text` belongs to (undefined between lines), and the line
   *  whose stretch of the source holds each footnote reference. A line's
   *  markers take that line's own references, in order; a reference its
   *  translation does not place follows that line's text, unless another
   *  line's marker has none of its own to take (review r7). A reference no line
   *  holds, or a paragraph with no lines given, is placed in order as before. */
  lineOf?: readonly (number | undefined)[]
  footnoteLines?: ReadonlyMap<DocxPiece, number>
  /** AQU-2552 (review r6): what a hidden or deleted line held in the source
   *  paragraph (see `withoutLost`), and which characters of a run that holds
   *  words of both a lost line and another are the lost line's. It
   *  contributes nothing: no footnote reference, picture, field or tab, and
   *  no word of it is reported as having lost its look. */
  lost?: ReadonlySet<DocxPiece>
  lostChar?: (piece: DocxPiece, i: number) => boolean
  /** AQU-2552 (review r7): pieces after the paragraph's first word that sit
   *  among the words of a line written as its source, each with the index of
   *  `text` it is written before; the rest follow the translation. */
  inlineAt?: ReadonlyMap<DocxPiece, number>
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
  /** The source words of each stretch with a look of its own that a reader
   *  sees (see `seenDifferently`) and that the translation does not hold, so
   *  they were written in the paragraph's main look (or the translation's own
   *  marks). */
  lostLooks: string[]
}

/** What a reader sees of a run's look. Language, proofing, character spacing
 *  and the complex-script twins of bold, italic and size are left out. */
const SEEN_LOOK = [
  "rStyle", "rFonts", "b", "i", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss",
  "imprint", "vanish", "color", "w", "position", "sz", "highlight", "u", "effect", "bdr", "shd", "vertAlign", "em",
]
/** A toggle switched off reads as the toggle left out. */
const OFF = /\sw:val="(0|false|none)"/

/** Does a reader see these two run looks differently? */
export function seenDifferently(a: string, b: string): boolean {
  const seen = (rPr: string, name: string) => {
    const el = rPr ? directRprChild(rPr, name) : null
    return el === null || OFF.test(el) ? null : el
  }
  return SEEN_LOOK.some((name) => seen(a, name) !== seen(b, name))
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
    unplacedMarkers: 0, lostLooks: [],
  }

  // Footnote markers in the translation, and the reference runs they take.
  const markers = [...input.text.matchAll(FOOTNOTE_SPAN_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }))
  let masked = input.text
  for (const m of markers) {
    masked = masked.slice(0, m.start) + TRANSLATION_FOOTNOTE.repeat(m.end - m.start) + masked.slice(m.end)
  }
  const written = input.writtenText ?? input.text

  let nodes = buildNodes(input.items, input.lineSet)
  if (input.lost && input.lost.size > 0) nodes = withoutLost(nodes, input.lost)
  const refs: { xml: string; id: string; line: number | undefined }[] = []
  collectMarkers(nodes, (piece) => {
    refs.push({ xml: io.elementXml(piece.run), id: piece.id, line: input.footnoteLines?.get(piece) })
  })

  // Match, then open up what did not match, until nothing changes.
  let matches: Map<RNode, Match>
  for (;;) {
    const lost: { text: string; look: string }[] = []
    matches = matchAnchors(nodes, masked, input.baseRpr, io, lost, input.lostChar)
    result.lostLooks = lost.filter((l) => seenDifferently(l.look, input.baseRpr)).map((l) => l.text)
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
        if (!holdsText(node) && node.partial) {
          // AQU-2552 (review r6): what a hidden or deleted line left of it,
          // in its own tags.
          next.push({ kind: "emptyField", piece: node.piece, children: node.children })
        } else if (!holdsText(node)) {
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
  const inline: { at: number; node: RNode }[] = []
  const inlineOf = (node: RNode, k: number) =>
    firstWord !== -1 && k > firstWord && node.kind === "keep" ? input.inlineAt?.get(node.piece) : undefined
  // AQU-2552 (review r8): a bookmark or comment mark is placed among the words
  // only when every other mark of its pair is placed there too; otherwise
  // they all follow the translation, in order, so none ends before it starts.
  const pairs = new Map<string, { inline: boolean; start: boolean; end: boolean }>()
  const inlineNodes = new Set(nodes.filter((node, k) => inlineOf(node, k) !== undefined))
  for (const leaf of leavesOf(nodes)) {
    const pair = pairOf(leaf.piece)
    if (!pair) continue
    const entry = pairs.get(pair.key) ?? { inline: true, start: false, end: false }
    if (!inlineNodes.has(leaf)) entry.inline = false
    if (pair.side === "start") entry.start = true
    if (pair.side === "end") entry.end = true
    pairs.set(pair.key, entry)
  }
  const pairedInline = (node: RNode) => {
    const pair = node.kind === "keep" ? pairOf(node.piece) : null
    const entry = pair ? pairs.get(pair.key) : undefined
    return !entry || (entry.inline && entry.start && entry.end)
  }
  // The end of a range copied in place inside a matched link or content
  // control (an untranslated line's) comes before the translation's end, so
  // a start mark of that range that would follow the translation goes in
  // front of it instead.
  const framedEnds = new Set<string>()
  for (const node of matches.keys()) {
    if (node.kind !== "wrapper" && node.kind !== "field") continue
    for (const leaf of leavesOf([node])) {
      const pair = pairOf(leaf.piece)
      if (pair && pair.side !== "start") framedEnds.add(pair.key)
    }
  }
  const startOfFramed = (node: RNode) => {
    const pair = node.kind === "keep" ? pairOf(node.piece) : null
    return pair !== null && pair.side === "start" && framedEnds.has(pair.key)
  }
  nodes.forEach((node, k) => {
    if (node.kind === "text" || node.kind === "marker" || matches.has(node)) return
    const at = pairedInline(node) ? inlineOf(node, k) : undefined
    if (at !== undefined) inline.push({ at, node })
    else (firstWord === -1 || k <= firstWord || startOfFramed(node) ? front : back).push(node)
  })
  inline.sort((a, b) => a.at - b.at)

  // The translation, with matched stretches written as the source had them.
  const ordered = [...matches.entries()].sort((a, b) => a[1].start - b[1].start)
  let stream = ""
  let cursor = 0
  // AQU-2552 (review r6): footnote references by line (see `lineOf`); a
  // line's references left over follow its text.
  const used = new Set<number>()
  // AQU-2552 (review r7): which reference each marker takes, decided before
  // anything is written. First every marker takes its own line's next one.
  // A marker left without one then takes a reference of another line whose
  // translation does not place it (the translator moved the note into this
  // line), in order, and only then one no line holds.
  const taken = new Map<number, number>()
  const claimed = new Set<number>()
  const claim = (m: number, test: (ref: (typeof refs)[number]) => boolean) => {
    const k = refs.findIndex((ref, i) => !claimed.has(i) && test(ref))
    if (k === -1) return
    claimed.add(k)
    taken.set(m, k)
  }
  markers.forEach((marker, m) => {
    const line = input.lineOf?.[marker.start]
    if (line !== undefined) claim(m, (ref) => ref.line === line)
  })
  markers.forEach((_, m) => { if (!taken.has(m)) claim(m, (ref) => ref.line !== undefined) })
  markers.forEach((_, m) => { if (!taken.has(m)) claim(m, (ref) => ref.line === undefined) })
  // A claimed reference is written at its marker, never at its line's end.
  for (const k of claimed) used.add(k)
  const placed = new Set<number>()
  const takeRef = (m: number) => {
    const k = taken.get(m)
    if (k !== undefined) placed.add(k)
    return k === undefined ? null : refs[k]
  }
  // Where each line that holds a reference ends (after its last character).
  const holding = new Set(refs.map((ref) => ref.line))
  const ends = new Map<number, number>()
  input.lineOf?.forEach((line, i) => {
    if (line !== undefined && holding.has(line)) ends.set(line, i + 1)
  })
  const lineEnds = [...ends].map(([line, at]) => ({ at, line })).sort((a, b) => a.at - b.at)
  let nextInline = 0
  const inlineTo = (k: number) => {
    const batch: RNode[] = []
    while (nextInline < inline.length && inline[nextInline].at <= k) batch.push(inline[nextInline++].node)
    if (batch.length > 0) stream += renderLeaves(batch, io)
  }
  let nextEnd = 0
  const endLinesTo = (k: number) => {
    while (nextEnd < lineEnds.length && lineEnds[nextEnd].at <= k) {
      const { line } = lineEnds[nextEnd++]
      refs.forEach((ref, i) => {
        if (ref.line !== line || used.has(i)) return
        used.add(i)
        stream += ref.xml
      })
    }
  }
  const plain = (from: number, to: number) => {
    let k = from
    while (k < to) {
      endLinesTo(k)
      inlineTo(k)
      const m = markers.findIndex((marker) => marker.start === k)
      const marker = m === -1 ? undefined : markers[m]
      if (marker) {
        const ref = takeRef(m)
        if (ref) {
          result.footnotes.push({ id: ref.id, marker: input.text.slice(marker.start, marker.end) })
          stream += ref.xml
        } else {
          result.unplacedMarkers++
        }
        k = marker.end
        continue
      }
      const next = Math.min(to, markers.find((m) => m.start > k)?.start ?? to, lineEnds[nextEnd]?.at ?? to, inline[nextInline]?.at ?? to)
      stream += runsByLook(written, k, next, (i) => input.sourceLooks?.[i] ?? lookFor(input, input.marks[i] ?? new Set()))
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
    endLinesTo(start)
    inlineTo(start)
    if (node.kind === "wrapper" || node.kind === "field") {
      stream += renderVerbatim(node.kind === "wrapper" ? [node] : [...node.open, ...node.result, node.close], io)
      if (node.kind === "field") result.keptFields++
      else if (node.piece.el.tagName === "w:hyperlink") result.keptLinks++
      else if (node.piece.el.tagName === "w:fldSimple") result.keptFields++
    } else {
      const looks = match.looks!
      stream += runsByLook(match.text!, 0, match.text!.length, (i) => looks[i])
      result.keptLooks++
    }
    cursor = end
  }
  plain(cursor, input.text.length)
  endLinesTo(Infinity)
  inlineTo(Infinity)
  // (A claimed reference whose marker was never reached is not lost.)
  const leftover = refs.filter((_, i) => !used.has(i) || (claimed.has(i) && !placed.has(i))).map((ref) => ref.xml).join("")

  result.xml = renderLeaves(front, io) + stream + leftover + renderLeaves(back, io)
  return result
}

function lookFor(input: RebuildInput, marks: ReadonlySet<Mark>): string {
  const key = markKey(marks)
  const look = key === ""
    ? input.baseRpr
    : rPrWithMarks(input.baseRpr || null, marks)
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

/**
 * AQU-2552 (review r6): the nodes without what a hidden or deleted line held
 * (`lost`, see docx.ts placeInLines). Its text, footnote references and runs
 * go. A field or a wrapper (a link, a content control…) goes whole, its own
 * properties included, when all the text it holds is lost, or, holding none,
 * when all its runs are; a bookmark or comment mark it held stays, unwrapped. One that lost only some of its
 * pieces stays, without them. A field character outside a whole field (a
 * field running over several paragraphs) always stays.
 */
function withoutLost(nodes: readonly RNode[], lost: ReadonlySet<DocxPiece>): RNode[] {
  const out: RNode[] = []
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
      case "marker":
        if (!lost.has(node.piece)) out.push(node)
        break
      case "keep":
        if (fieldCharOf(node) !== null || !lost.has(node.piece)) out.push(node)
        break
      case "wrapper":
      case "field": {
        const inner = node.kind === "wrapper" ? node.children : [...node.open, ...node.result, node.close]
        const leaves = leavesOf(inner)
        const text = leaves.filter((leaf) => leaf.kind !== "keep")
        const runs = leaves.filter((leaf) => leaf.kind === "keep" && isRunPiece(leaf.piece))
        const judged = text.length > 0 ? text : runs
        const gone = judged.filter((leaf) => lost.has(leaf.piece)).length
        if (judged.length > 0 && gone === judged.length) {
          // AQU-2552 (review r8): its own properties (a content control's
          // w:sdtPr, a smart tag's w:smartTagPr…) go with it; left loose in
          // the paragraph they make a file Word calls damaged.
          out.push(...withoutLost(inner.filter((n) => !(n.kind === "keep" && (isRunPiece(n.piece) || isWrapperProperties(n.piece)))), lost))
        } else if (leaves.some((leaf) => lost.has(leaf.piece))) {
          out.push(node.kind === "wrapper"
            ? { ...node, children: withoutLost(node.children, lost), partial: true }
            : { ...node, result: withoutLost(node.result, lost), partial: true })
        } else {
          out.push(node)
        }
        break
      }
      default:
        out.push(node)
    }
  }
  return out
}

type LeafNode = Extract<RNode, { kind: "text" | "marker" | "keep" }>

function leavesOf(nodes: readonly RNode[]): LeafNode[] {
  return nodes.flatMap((node): LeafNode[] => {
    switch (node.kind) {
      case "text":
      case "marker":
      case "keep":
        return [node]
      case "wrapper":
      case "emptyField":
        return leavesOf(node.children)
      case "field":
        return leavesOf([...node.open, ...node.result, node.close])
      case "emptied":
        return leavesOf(node.nodes)
    }
  })
}

/** AQU-2552 (review r8): marks that pair up across the paragraph (a range's
 *  start and end, a comment's reference), with the side each is. */
const PAIRED_MARKS: Record<string, [string, "start" | "end"]> = {
  "w:bookmarkStart": ["bookmark", "start"], "w:bookmarkEnd": ["bookmark", "end"],
  "w:commentRangeStart": ["comment", "start"], "w:commentRangeEnd": ["comment", "end"],
  "w:moveFromRangeStart": ["moveFrom", "start"], "w:moveFromRangeEnd": ["moveFrom", "end"],
  "w:moveToRangeStart": ["moveTo", "start"], "w:moveToRangeEnd": ["moveTo", "end"],
  "w:permStart": ["perm", "start"], "w:permEnd": ["perm", "end"],
}
function pairOf(piece: Leaf): { key: string; side: "start" | "end" | "reference" } | null {
  const children = piece.kind === "keepInRun" ? piece.children : piece.kind === "keep" && piece.el.tagName === "w:r" ? piece.el.children : null
  if (children) {
    const reference = children.find((c): c is XmlElement => isElement(c) && c.tagName === "w:commentReference")
    return reference ? { key: `comment:${reference.attributes["w:id"] ?? ""}`, side: "reference" } : null
  }
  const mark = piece.kind === "keep" ? PAIRED_MARKS[piece.el.tagName] : undefined
  return mark ? { key: `${mark[0]}:${piece.el.attributes["w:id"] ?? ""}`, side: mark[1] } : null
}

/** AQU-2552 (review r8): a wrapper's own properties, valid only inside it. */
const WRAPPER_PROPERTIES = new Set(["w:sdtPr", "w:sdtEndPr", "w:smartTagPr", "w:customXmlPr", "w:fldData"])
function isWrapperProperties(piece: Leaf): boolean {
  return piece.kind === "keep" && WRAPPER_PROPERTIES.has(piece.el.tagName)
}

/** A run of the source, or part of one: what a field is made of. */
function isRunPiece(piece: Leaf): boolean {
  return piece.kind === "keepInRun" || piece.kind === "footnote" || piece.kind === "text" || (piece.kind === "keep" && piece.el.tagName === "w:r")
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
  /** For a look stretch: the source's own text and the look of each of its
   *  characters (it is written from the source, so a translation that holds
   *  the same word in another Unicode form gets the source's bytes). */
  looks?: string[]
  text?: string
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
const LATIN_LETTER = /[A-Za-z]/

/** The guard against silly matches (see the header): a look stretch counts
 *  when it holds a letter or digit and is not a lone Latin letter or digit. */
export function anchorCounts(needle: string): boolean {
  return HAS_LETTER_OR_DIGIT.test(needle) && !LONE_LATIN.test(needle)
}

function trimmed(text: string): { lead: number; text: string } {
  const lead = text.length - text.trimStart().length
  return { lead, text: text.trim() }
}

function anchorsOf(
  nodes: readonly RNode[],
  baseRpr: string,
  io: RebuildIo,
  lostChar?: (piece: DocxPiece, i: number) => boolean,
): { anchors: Anchor[]; text: string; unsought: LostStretch[] } {
  const anchors: Anchor[] = []
  /** Look stretches with a letter or digit too short to be looked for. */
  const unsought: LostStretch[] = []
  let offset = 0
  let levelText = ""
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
      // One look, joined across whitespace whatever look the whitespace has
      // (in a real file most spaces carry their own spacing value).
      const look = chars[k].look
      let end = k + 1
      for (;;) {
        while (end < chars.length && chars[end].special && chars[end].look === look) end++
        let gap = end
        while (gap < chars.length && /\s/.test(chars[gap].ch)) gap++
        if (gap > end && gap < chars.length && chars[gap].special && chars[gap].look === look) {
          end = gap
          continue
        }
        break
      }
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
        // A word taken OUT of a stretch must be at least 3 characters or not
        // Latin: alone, "de" of an italic "de facto" would take the French "de".
        if (word && (word.needle.length >= 3 || !LATIN_LETTER.test(word.needle))) words.push(word)
        k = end
      }
      const whole = part(0, slice.length)
      const openedUp = words.length === 1 && whole?.needle === words[0].needle ? [] : words
      if (whole) anchors.push({ node: owner[unit.start], ...whole, words: openedUp })
      else for (const word of words) anchors.push({ node: owner[unit.start], ...word, words: [] })
      const raw = slice.map((c) => c.ch).join("").trim()
      if (!whole && words.length === 0 && HAS_LETTER_OR_DIGIT.test(raw)) {
        unsought.push({ text: raw, look: slice.find((c) => c.special)!.look })
      }
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
        // AQU-2552 (review r6): a hidden or deleted line's words are never
        // looked for, nor reported: they end a stretch, like a frame.
        if (lostChar?.(node.piece, i)) {
          flushStretches()
          offset++
          continue
        }
        chars.push({ ch: text[i], look, special: look !== baseRpr, at: offset })
        owner.push(node)
        offset++
      }
      levelText += text
      continue
    }
    if (node.kind === "keep") continue
    flushStretches()
    const text = textOf(node)
    // AQU-2552 (review r6): one that lost pieces to a hidden or deleted line
    // is never copied byte for byte, so it is not looked for.
    if ((node.kind === "wrapper" || node.kind === "field") && !node.partial) {
      const { lead, text: needle } = trimmed(text)
      // A field or link is found by its whole visible text, however short
      // (a caption's number "1"): its own structure is the anchor.
      if (HAS_LETTER_OR_DIGIT.test(needle) && !needle.includes(SOURCE_FOOTNOTE)) {
        anchors.push({ node, order: offset + lead, needle })
      }
    }
    offset += text.length
    levelText += text
  }
  flushStretches()
  return { anchors: anchors.sort((a, b) => a.order - b.order), text: levelText, unsought }
}

/** A look stretch the translation does not hold: its words and its look. */
interface LostStretch {
  text: string
  look: string
}

function matchAnchors(
  nodes: readonly RNode[],
  masked: string,
  baseRpr: string,
  io: RebuildIo,
  lost: LostStretch[],
  lostChar?: (piece: DocxPiece, i: number) => boolean,
): Map<RNode, Match> {
  const out = new Map<RNode, Match>()
  const lookMatches: Match[] = []
  let cursor = 0
  const { anchors, text: sourceText, unsought } = anchorsOf(nodes, baseRpr, io, lostChar)
  // A stretch grown to its whole word ("12th" from a superscript "th") starts
  // in the main look: its own look is the first one that is not.
  const ownLook = (looks: readonly string[]) => looks.find((look) => look !== baseRpr) ?? looks[0]
  lost.push(...unsought)
  // In source order; when the translation holds the text as often as the
  // source paragraph does, the source's n-th occurrence takes the n-th.
  const find = (needle: string, order: number) => {
    const inSource = wholeOccurrences(sourceText, needle)
    const inTarget = wholeOccurrences(masked, needle)
    const n = inSource.indexOf(order)
    if (n !== -1 && inSource.length === inTarget.length && inTarget[n] >= cursor) {
      return { start: inTarget[n], end: inTarget[n] + needle.length }
    }
    return findWhole(masked, needle, cursor)
  }
  for (const anchor of anchors) {
    // A look stretch's node may carry several stretches; frames carry one.
    if (anchor.looks === undefined && out.has(anchor.node)) continue
    const found = find(anchor.needle, anchor.order)
    if (found !== null) {
      const match = { ...found, ...(anchor.looks ? { looks: anchor.looks, text: anchor.needle } : {}) }
      if (anchor.looks) lookMatches.push(match)
      else out.set(anchor.node, match)
      cursor = match.end
      continue
    }
    // Not found whole: open it up into its words. What is not found of a
    // look stretch is lost: the whole stretch when none of its words is found.
    const missing: LostStretch[] = []
    for (const word of anchor.words ?? []) {
      const wordFound = find(word.needle, word.order)
      if (wordFound === null) {
        missing.push({ text: word.needle, look: ownLook(word.looks) })
        continue
      }
      lookMatches.push({ ...wordFound, looks: word.looks, text: word.needle })
      cursor = wordFound.end
    }
    if (!anchor.looks) continue
    if (missing.length === (anchor.words?.length ?? 0)) lost.push({ text: anchor.needle, look: ownLook(anchor.looks) })
    else lost.push(...missing)
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

/**
 * The first whole-word occurrence of `needle` in `hay` at or after `from`, as
 * a range of `hay`, or null. When the exact characters are not there, the
 * same text in another Unicode normal form counts (Hebrew points or Greek
 * accents composed or ordered differently): both are compared in NFC.
 */
function findWhole(hay: string, needle: string, from: number): { start: number; end: number } | null {
  const exact = findWholeExact(hay, needle, from)
  if (exact !== -1) return { start: exact, end: exact + needle.length }
  const target = needle.normalize("NFC")
  const normal = normalizedWithMap(hay)
  if (target === needle && normal.text === hay) return null
  let k = 0
  while (k < normal.starts.length && normal.starts[k] < from) k++
  const fromNormal = k < normal.starts.length ? normal.offsets[k] : normal.text.length
  let at = findWholeExact(normal.text, target, fromNormal)
  while (at !== -1) {
    // A match must begin and end on whole characters of the original text.
    const first = normal.offsets.indexOf(at)
    const last = normal.offsets.indexOf(at + target.length)
    const endsCleanly = last !== -1 || at + target.length === normal.text.length
    if (first !== -1 && endsCleanly) {
      return { start: normal.starts[first], end: last === -1 ? hay.length : normal.starts[last] }
    }
    at = findWholeExact(normal.text, target, at + 1)
  }
  return null
}

/** `text` in NFC, one cluster (a character and its combining marks) at a time,
 *  with where each cluster starts in the original and in the normalised text. */
let lastNormalized: { source: string; result: { text: string; starts: number[]; offsets: number[] } } | null = null

function normalizedWithMap(text: string): { text: string; starts: number[]; offsets: number[] } {
  if (lastNormalized?.source === text) return lastNormalized.result
  const result = buildNormalizedMap(text)
  lastNormalized = { source: text, result }
  return result
}

function buildNormalizedMap(text: string): { text: string; starts: number[]; offsets: number[] } {
  const starts: number[] = []
  const offsets: number[] = []
  let out = ""
  const cluster = /\P{M}\p{M}*|\p{M}+/gu
  let m: RegExpExecArray | null
  while ((m = cluster.exec(text)) !== null) {
    starts.push(m.index)
    offsets.push(out.length)
    out += m[0].normalize("NFC")
  }
  return { text: out, starts, offsets }
}

/** Where `needle` occurs in `hay` as a whole word, in order. */
function wholeOccurrences(hay: string, needle: string): number[] {
  const out: number[] = []
  for (let at = findWholeExact(hay, needle, 0); at !== -1; at = findWholeExact(hay, needle, at + 1)) out.push(at)
  return out
}

/** First whole-word occurrence of `needle` in `hay` at or after `from`. */
function findWholeExact(hay: string, needle: string, from: number): number {
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
