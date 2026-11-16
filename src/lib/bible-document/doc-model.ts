// The Bible document (AQU-2559) as plain JSON: how a list of units becomes the
// editor's document, and how the document is read back into one value per
// cell. Both directions are pure, so the contract between them is tested
// without an editor.
//
// A verse is a chip (an inline atom carrying the cell id) followed by its
// words, up to the next chip. A verse can therefore run across paragraphs
// (poetry lines), and a paragraph can hold many verses.
//
// Layout the translation adds is written into the verse that FOLLOWS it, as a
// lead (see db/shared/usfm-layout.ts): `\s1 Title`, `\p`, `\q1`, or `\nb` for
// "no break here". A verse whose layout matches the source carries no lead.

import {
  USFM_LEAD_HEADING_MARKERS,
  USFM_PARAGRAPH_MARKERS,
  composeUsfmLead,
  isNoBreakLead,
  splitUsfmLead,
  splitUsfmTail,
  type UsfmLeadBlock,
} from "../../../db/shared/usfm-layout"
import type { DocUnit } from "./units"

export interface TextJSON { type: "text"; text: string }
export interface VerseJSON { type: "verse"; attrs: { cellId: string; label: string } }
export interface NoteJSON { type: "note"; attrs: { raw: string } }
export type InlineJSON = TextJSON | VerseJSON | NoteJSON

export interface ChapterLabelJSON { type: "chapterLabel"; attrs: { chapter: number } }
export interface CellHeadingJSON { type: "cellHeading"; attrs: { cellId: string; marker: string }; content?: TextJSON[] }
export interface AddedHeadingJSON { type: "addedHeading"; attrs: { marker: string }; content?: TextJSON[] }
export interface ParaJSON { type: "para"; attrs: { marker: string }; content?: InlineJSON[] }
export type BlockJSON = ChapterLabelJSON | CellHeadingJSON | AddedHeadingJSON | ParaJSON
export interface DocJSON { type: "doc"; content: BlockJSON[] }

const DEFAULT_MARKER = "p"
/** A note, or a marker at the start of a line inside a verse. */
const BODY_TOKEN = /\\(f|fe|ef|x|ex)\s[\s\S]*?\\\1\*|(?:\r?\n)+[ \t]*\\([a-z]+\d*)(?=[ \t\r\n]|$)[ \t]?/g

function text(value: string): TextJSON[] {
  return value === "" ? [] : [{ type: "text", text: value }]
}

/** The paragraph marker a lead or tail names; null when it names none. */
function paragraphMarkerOf(blocks: readonly UsfmLeadBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const marker = blocks[i].marker
    if (blocks[i].text === "" && marker !== "nb" && marker !== "b") return marker
  }
  return null
}

export function buildDoc(units: readonly DocUnit[]): DocJSON {
  const blocks: BlockJSON[] = []
  let para: ParaJSON | null = null
  let lastChapter: number | null = null
  /** A paragraph marker the previous verse's own text ended with. */
  let carried: string | null = null

  const openPara = (marker: string): ParaJSON => {
    para = { type: "para", attrs: { marker }, content: [] }
    blocks.push(para)
    return para
  }
  const pushInline = (node: InlineJSON) => {
    const target = para ?? openPara(DEFAULT_MARKER)
    const content = target.content ?? (target.content = [])
    const last = content[content.length - 1]
    if (node.type === "text" && last?.type === "text") last.text += node.text
    else content.push(node)
  }

  for (const unit of units) {
    // The chapter number drops into the chapter's first paragraph, so it comes
    // after any heading that opens the chapter, as in a printed Bible.
    if (unit.kind === "verse" && unit.chapter !== null && unit.chapter > 0 && unit.chapter !== lastChapter) {
      blocks.push({ type: "chapterLabel", attrs: { chapter: unit.chapter } })
      para = null
      lastChapter = unit.chapter
    }

    if (unit.kind === "heading") {
      blocks.push({
        type: "cellHeading",
        attrs: { cellId: unit.cellId, marker: unit.headingMarker ?? "s1" },
        content: text(unit.target.trim()),
      })
      para = null
      carried = null
      continue
    }

    const lead = splitUsfmLead(unit.target)
    const own = splitUsfmTail(lead.body)
    const noBreak = isNoBreakLead(lead.blocks)
    const sourceMarker = unit.sourceParagraphMarker ?? DEFAULT_MARKER

    for (const block of lead.blocks) {
      if (block.text === "" || !USFM_LEAD_HEADING_MARKERS.has(block.marker)) continue
      blocks.push({ type: "addedHeading", attrs: { marker: block.marker }, content: text(block.text) })
      para = null
    }
    let start: string | null = null
    if (para === null) start = paragraphMarkerOf(lead.blocks) ?? carried ?? sourceMarker
    else if (lead.blocks.length > 0) start = noBreak ? null : paragraphMarkerOf(lead.blocks) ?? sourceMarker
    else if (carried) start = carried
    else if (unit.sourceParagraphStart) start = sourceMarker
    if (start !== null) openPara(start)

    pushInline({ type: "verse", attrs: { cellId: unit.cellId, label: unit.label } })

    // The words: notes become atoms, a paragraph marker at a line start opens a
    // new paragraph inside the verse, any other line break is a space.
    let body = own.body.trim()
    if (/^\\[a-z]+\d*(?=[ \t\r\n]|$)/.test(body)) body = `\n${body}`
    let cursor = 0
    let afterBreak = false
    const pushText = (raw: string) => {
      let value = raw.replace(/\s*\r?\n\s*/g, " ")
      if (afterBreak) value = value.trimStart()
      if (value === "") return
      afterBreak = false
      pushInline({ type: "text", text: value })
    }
    for (const m of body.matchAll(BODY_TOKEN)) {
      const index = m.index ?? 0
      if (m[2] !== undefined && !USFM_PARAGRAPH_MARKERS.has(m[2])) continue
      pushText(body.slice(cursor, index))
      if (m[2] !== undefined) {
        const open = para as ParaJSON | null
        const last = open?.content?.[open.content.length - 1]
        if (last?.type === "text") last.text = last.text.trimEnd()
        openPara(m[2])
        afterBreak = true
      } else {
        afterBreak = false
        pushInline({ type: "note", attrs: { raw: m[0] } })
      }
      cursor = index + m[0].length
    }
    pushText(body.slice(cursor))

    carried = own.tail.trim() === "" ? null : paragraphMarkerOf(splitUsfmLead(own.tail.trim()).blocks)
  }

  if (blocks.length === 0) blocks.push({ type: "para", attrs: { marker: DEFAULT_MARKER } })
  return { type: "doc", content: blocks }
}

export interface UnitLayout {
  paragraphStart: boolean
  paragraphMarker: string | null
}

export interface DocReading {
  /** One value per cell in the document. */
  values: Map<string, string>
  /** The fixed skeleton: cell ids and chapter labels, in order. An edit may
   *  never change it. */
  skeleton: string[]
  /** True when words sit where no verse can own them. */
  orphanText: boolean
}

export function layoutOf(units: readonly DocUnit[]): Map<string, UnitLayout> {
  const out = new Map<string, UnitLayout>()
  for (const u of units) out.set(u.cellId, { paragraphStart: u.sourceParagraphStart, paragraphMarker: u.sourceParagraphMarker })
  return out
}

export function readDoc(doc: DocJSON, layout: ReadonlyMap<string, UnitLayout>): DocReading {
  const values = new Map<string, string>()
  const skeleton: string[] = []
  let orphanText = false
  let current: { cellId: string; lead: UsfmLeadBlock[]; body: string } | null = null
  let pending: UsfmLeadBlock[] = []
  /** The next verse starts a paragraph whatever the source says: it follows a
   *  chapter label or a heading. */
  let forced = true

  const flush = () => {
    if (!current) return
    values.set(current.cellId, composeUsfmLead(current.lead, current.body.trim()))
    current = null
  }

  for (const block of doc.content) {
    if (block.type === "chapterLabel") {
      flush()
      skeleton.push(`#chapter:${block.attrs.chapter}`)
      forced = true
      continue
    }
    if (block.type === "cellHeading") {
      flush()
      values.set(block.attrs.cellId, (block.content ?? []).map((t) => t.text).join("").trim())
      skeleton.push(block.attrs.cellId)
      forced = true
      continue
    }
    if (block.type === "addedHeading") {
      flush()
      const title = (block.content ?? []).map((t) => t.text).join("").trim()
      if (title !== "") pending.push({ marker: block.attrs.marker, text: title })
      continue
    }
    const marker = block.attrs.marker
    let first = true
    for (const node of block.content ?? []) {
      if (node.type === "verse") {
        flush()
        const source = layout.get(node.attrs.cellId) ?? { paragraphStart: false, paragraphMarker: null }
        const inheritedStart = forced || source.paragraphStart
        const inheritedMarker = source.paragraphMarker ?? DEFAULT_MARKER
        let lead: UsfmLeadBlock[] = []
        if (first) {
          if (pending.length > 0 || !inheritedStart || marker !== inheritedMarker) lead = [...pending, { marker, text: "" }]
        } else if (source.paragraphStart) {
          lead = [{ marker: "nb", text: "" }]
        }
        pending = []
        current = { cellId: node.attrs.cellId, lead, body: "" }
        skeleton.push(node.attrs.cellId)
      } else if (!current) {
        if (node.type === "note" || node.text.trim() !== "") orphanText = true
      } else {
        if (first) current.body = `${current.body.trimEnd()}\n\\${marker} `
        current.body += node.type === "note" ? node.attrs.raw : node.text
      }
      first = false
      forced = false
    }
  }
  flush()
  return { values, skeleton, orphanText }
}
