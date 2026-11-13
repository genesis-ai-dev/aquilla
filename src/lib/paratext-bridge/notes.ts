// Paratext project notes. Each Paratext user owns one file in the project
// folder, `Notes_<User>.xml`: a flat <CommentList> of <Comment> elements that
// Paratext rewrites whole from memory whenever that user saves a note. The
// 2026-11-06 live test showed a well-formed <Comment> appended from outside
// survives that rewrite, so the bridge appends to the registered user's file
// only, with the same discipline as book writes: re-read, splice, re-parse,
// prove nothing else moved.
//
// Pure: no I/O. Parsing is regex-based on purpose — the file is machine
// written with one <Comment> per block and no nesting, and a DOM parser would
// drop the byte offsets the proof needs.

export interface ParatextNote {
  thread: string
  user: string
  verseRef: string
  date: string
  status: string
  selectedText: string
  startPosition: number
  /** Plain text of <Contents>, tags stripped, paragraphs joined by newlines. */
  text: string
  /** Biblical-terms bookkeeping notes Paratext hides from the text window. */
  hidden: boolean
  /** Raw bytes range of the <Comment> block, for the append proof. */
  span: { start: number; end: number }
}

export interface NotesFile {
  notes: ParatextNote[]
  bom: boolean
  crlf: boolean
}

export interface NoteDraft {
  user: string
  /** Paratext verse reference, e.g. "MAT 1:2". */
  verseRef: string
  /** Verse number as written in the file ("2", "3-4"); used for the \v anchor. */
  verse: string
  /** Current text of the verse, stored as Paratext's <Verse> context. */
  verseText: string
  text: string
  /** Fixed for tests; defaults to a fresh 8-hex id like Paratext's. */
  thread?: string
  /** Fixed for tests; defaults to now in Paratext's local-offset format. */
  date?: string
}

export interface NoteAppendPlan {
  ok: boolean
  bytes: Uint8Array | null
  /** The note as it parses back out of `bytes`. */
  note: ParatextNote | null
  proofFailures: string[]
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
const encoder = new TextEncoder()
const BOM = "﻿"

export function notesFileName(user: string): string {
  return `Notes_${user}.xml`
}

export function isNotesFileName(name: string): boolean {
  return name.startsWith("Notes_") && name.toLowerCase().endsWith(".xml")
}

function attr(block: string, name: string): string {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(block)
  return m ? unescapeXml(m[1]) : ""
}

function element(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>|<${name}\\s*/>`).exec(block)
  if (!m) return null
  return m[1] ?? ""
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function contentsText(inner: string): string {
  const paras = [...inner.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((m) => m[1])
  const parts = paras.length > 0 ? paras : [inner]
  return parts.map((p) => unescapeXml(p.replace(/<[^>]+>/g, "")).trim()).filter(Boolean).join("\n")
}

/** Parse a notes file. Byte offsets in `span` are UTF-8 offsets into `bytes`. */
export function parseNotes(bytes: Uint8Array): NotesFile {
  const text = decoder.decode(bytes)
  const bom = text.startsWith(BOM)
  const crlf = text.includes("\r\n")
  const notes: ParatextNote[] = []
  const re = /<Comment\s[^>]*>[\s\S]*?<\/Comment>/g
  // Byte offsets: walk the string once, mapping UTF-16 index → UTF-8 offset.
  let utf16 = 0
  let utf8 = 0
  const toUtf8 = (idx: number): number => {
    while (utf16 < idx) {
      const cp = text.codePointAt(utf16)!
      utf8 += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
      utf16 += cp >= 0x10000 ? 2 : 1
    }
    return utf8
  }
  for (const m of text.matchAll(re)) {
    const block = m[0]
    const start = toUtf8(m.index)
    const end = toUtf8(m.index + block.length)
    const open = /<Comment\s[^>]*>/.exec(block)![0]
    notes.push({
      thread: attr(open, "Thread"),
      user: attr(open, "User"),
      verseRef: attr(open, "VerseRef"),
      date: attr(open, "Date"),
      status: element(block, "Status") ?? "",
      selectedText: unescapeXml(element(block, "SelectedText") ?? ""),
      startPosition: Number(element(block, "StartPosition") ?? "0") || 0,
      text: contentsText(element(block, "Contents") ?? ""),
      hidden: (element(block, "HideInTextWindow") ?? "false").trim() === "true",
      span: { start, end },
    })
  }
  return { notes, bom, crlf }
}

/** Paratext's own thread ids are 8 lowercase hex characters. */
export function newThreadId(): string {
  const b = new Uint8Array(4)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}

/** Paratext writes local time with seven fractional digits and the UTC offset. */
export function paratextDate(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? "+" : "-"
  const a = Math.abs(off)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}0000${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`
}

/** One <Comment> block in the shape Paratext 9.5 writes for a plain user note on a whole verse. */
export function buildNoteXml(draft: NoteDraft, eol: string): string {
  const thread = draft.thread ?? newThreadId()
  const date = draft.date ?? paratextDate()
  const anchor = `\\v ${draft.verse} `
  const lines = [
    `  <Comment Thread="${escapeXml(thread)}" User="${escapeXml(draft.user)}" VerseRef="${escapeXml(draft.verseRef)}" Language="en" Date="${date}">`,
    `    <SelectedText />`,
    `    <StartPosition>0</StartPosition>`,
    `    <ContextBefore>${escapeXml(anchor)}</ContextBefore>`,
    `    <ContextAfter />`,
    `    <Status></Status>`,
    `    <Type></Type>`,
    `    <ConflictType />`,
    `    <Verse>${escapeXml(anchor + draft.verseText)}</Verse>`,
    `    <ReplyToUser />`,
    `    <HideInTextWindow>false</HideInTextWindow>`,
    `    <Contents>${escapeXml(draft.text.trim())}</Contents>`,
    `  </Comment>`,
  ]
  return lines.join(eol) + eol
}

const EMPTY_FILE = (eol: string) => `${BOM}<?xml version="1.0" encoding="utf-8"?>${eol}<CommentList>${eol}</CommentList>${eol}`

/**
 * Append one note. `current` is the file as it is on disk right now, or null
 * when the user has no notes file yet (Paratext creates it on first note; so
 * do we, in Paratext's own shape: BOM, CRLF). The proof re-parses the result
 * and checks every existing note's bytes are untouched, in order, and exactly
 * one new note parses out with the requested thread id.
 */
export function planNoteAppend(current: Uint8Array | null, draft: NoteDraft): NoteAppendPlan {
  const thread = draft.thread ?? newThreadId()
  const d: NoteDraft = { ...draft, thread }
  const failures: string[] = []
  let text: string
  let before: NotesFile
  if (current === null || current.length === 0) {
    text = EMPTY_FILE("\r\n")
    before = { notes: [], bom: true, crlf: true }
  } else {
    text = decoder.decode(current)
    before = parseNotes(current)
  }
  const eol = before.crlf ? "\r\n" : "\n"
  const closeAt = text.lastIndexOf("</CommentList>")
  if (closeAt < 0) {
    return { ok: false, bytes: null, note: null, proofFailures: ["no </CommentList> in the notes file"] }
  }
  const next = text.slice(0, closeAt) + buildNoteXml(d, eol) + text.slice(closeAt)
  const bytes = encoder.encode(next)
  const after = parseNotes(bytes)

  if (after.notes.length !== before.notes.length + 1) {
    failures.push(`expected ${before.notes.length + 1} notes after append, parsed ${after.notes.length}`)
  }
  for (let i = 0; i < before.notes.length && i < after.notes.length; i++) {
    const a = before.notes[i]
    const b = after.notes[i]
    if (a.span.start !== b.span.start || a.span.end !== b.span.end || a.thread !== b.thread) {
      failures.push(`existing note ${a.thread} moved`)
      break
    }
  }
  const added = after.notes[after.notes.length - 1]
  if (!added || added.thread !== thread) failures.push("appended note did not parse back with its thread id")
  else if (added.text !== draft.text.trim()) failures.push("appended note text did not round-trip")
  // Bytes before the insertion point and the closing tag after it are unchanged.
  if (current && current.length > 0) {
    const prefix = encoder.encode(text.slice(0, closeAt))
    for (let i = 0; i < prefix.length; i++) if (prefix[i] !== bytes[i]) { failures.push("bytes before the appended note changed"); break }
    const tail = encoder.encode(text.slice(closeAt))
    for (let i = 0; i < tail.length; i++) if (tail[tail.length - 1 - i] !== bytes[bytes.length - 1 - i]) { failures.push("bytes after the appended note changed"); break }
  }
  return { ok: failures.length === 0, bytes: failures.length === 0 ? bytes : null, note: failures.length === 0 ? added : null, proofFailures: failures }
}

/** Paratext's VerseRef for a derived unit: verses by number, everything else as verse 0 of its chapter. */
export function unitVerseRef(book: string, unit: { kind: string; chapter: number; verse: string }): string {
  const v = unit.kind === "verse" ? unit.verse : "0"
  return `${book} ${unit.chapter}:${v}`
}

/** Notes anchored on a unit. A range verse "3-4" also collects notes on 3 or 4. */
export function notesForUnit(notes: readonly ParatextNote[], book: string, unit: { kind: string; chapter: number; verse: string }): ParatextNote[] {
  const refs = new Set<string>([unitVerseRef(book, unit)])
  if (unit.kind === "verse") {
    const m = /^(\d+)-(\d+)$/.exec(unit.verse)
    if (m) for (let v = Number(m[1]); v <= Number(m[2]); v++) refs.add(`${book} ${unit.chapter}:${v}`)
  }
  return notes.filter((n) => !n.hidden && refs.has(n.verseRef))
}
