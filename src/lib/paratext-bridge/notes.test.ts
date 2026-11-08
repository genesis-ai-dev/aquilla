import { describe, it, expect } from "vitest"
import { buildNoteXml, isNotesFileName, notesFileName, notesForUnit, paratextDate, parseNotes, planNoteAppend } from "./notes"

const enc = new TextEncoder()
const dec = new TextDecoder("utf-8", { ignoreBOM: true })

// Shape taken from a real Paratext 9.5 Notes_<User>.xml: BOM, CRLF, a hidden
// biblical-terms note and a plain user note with a selection anchor.
const REAL = [
  '﻿<?xml version="1.0" encoding="utf-8"?>',
  "<CommentList>",
  '  <Comment Thread="BT_מַשָּׂא-1" User="Ryder Wishart" VerseRef="2KI 9:25" Language="en" Date="2026-11-05T12:23:52.6534820-06:00">',
  "    <SelectedText />",
  "    <StartPosition>0</StartPosition>",
  "    <ContextBefore>\\v 25 </ContextBefore>",
  "    <ContextAfter />",
  "    <Status>todo</Status>",
  "    <Type></Type>",
  "    <ConflictType />",
  "    <Verse>\\v 25 </Verse>",
  "    <HideInTextWindow>true</HideInTextWindow>",
  "    <Contents>",
  "      <p>Paratext has identified a single term &amp; copied it.</p>",
  "    </Contents>",
  "    <BiblicalTermId>מַשָּׂא-1</BiblicalTermId>",
  "    <TagAdded>-3</TagAdded>",
  "  </Comment>",
  '  <Comment Thread="afe198a8" User="Ryder Wishart" VerseRef="MAT 1:2" Language="en" Date="2026-11-06T16:10:52.3429890-06:00">',
  "    <SelectedText>Ryderwrotethisverse</SelectedText>",
  "    <StartPosition>5</StartPosition>",
  "    <ContextBefore>\\v 2 </ContextBefore>",
  "    <ContextAfter> </ContextAfter>",
  "    <Status></Status>",
  "    <Type></Type>",
  "    <ConflictType />",
  "    <Verse>\\v 2 Ryderwrotethisverse </Verse>",
  "    <ReplyToUser />",
  "    <HideInTextWindow>false</HideInTextWindow>",
  "    <Contents>here's a note injected from paratext </Contents>",
  "  </Comment>",
  "</CommentList>",
  "",
].join("\r\n")

describe("parseNotes", () => {
  it("reads Paratext's own file shape, keeping byte spans past non-ASCII text", () => {
    const bytes = enc.encode(REAL)
    const f = parseNotes(bytes)
    expect(f.bom).toBe(true)
    expect(f.crlf).toBe(true)
    expect(f.notes.map((n) => n.thread)).toEqual(["BT_מַשָּׂא-1", "afe198a8"])
    expect(f.notes[0]).toMatchObject({ verseRef: "2KI 9:25", status: "todo", hidden: true, text: "Paratext has identified a single term & copied it." })
    expect(f.notes[1]).toMatchObject({ verseRef: "MAT 1:2", selectedText: "Ryderwrotethisverse", startPosition: 5, hidden: false, text: "here's a note injected from paratext" })
    // The span must slice the exact block even after the Hebrew thread id widened the UTF-8 offsets.
    const second = dec.decode(bytes.slice(f.notes[1].span.start, f.notes[1].span.end))
    expect(second.startsWith('<Comment Thread="afe198a8"')).toBe(true)
    expect(second.endsWith("</Comment>")).toBe(true)
  })
})

describe("planNoteAppend", () => {
  const draft = { user: "Ryder Wishart", verseRef: "MAT 1:1", verse: "1", verseText: "In the beginning <was> & so on", text: "  Check this rendering.  ", thread: "0123abcd", date: "2026-11-06T09:00:00.0000000-06:00" }

  it("appends one Paratext-shaped note and leaves every other byte alone", () => {
    const before = enc.encode(REAL)
    const plan = planNoteAppend(before, draft)
    expect(plan.proofFailures).toEqual([])
    expect(plan.ok).toBe(true)
    const after = plan.bytes!
    const f = parseNotes(after)
    expect(f.notes.length).toBe(3)
    expect(f.notes[2]).toMatchObject({ thread: "0123abcd", user: "Ryder Wishart", verseRef: "MAT 1:1", text: "Check this rendering.", hidden: false })
    // Prefix (everything up to </CommentList>) is byte-identical; the file still ends the same way.
    const closeAt = REAL.lastIndexOf("</CommentList>")
    const prefix = enc.encode(REAL.slice(0, closeAt))
    expect(after.slice(0, prefix.length)).toEqual(prefix)
    expect(dec.decode(after).endsWith("</CommentList>\r\n")).toBe(true)
    // The block uses the file's CRLF and escapes the verse text.
    const block = dec.decode(after.slice(f.notes[2].span.start, f.notes[2].span.end))
    expect(block).toContain("\r\n    <Verse>\\v 1 In the beginning &lt;was&gt; &amp; so on</Verse>")
    expect(block).toContain("<ReplyToUser />")
  })

  it("creates the file in Paratext's shape when the user has none yet", () => {
    const plan = planNoteAppend(null, draft)
    expect(plan.ok).toBe(true)
    const text = dec.decode(plan.bytes!)
    expect(text.startsWith('﻿<?xml version="1.0" encoding="utf-8"?>\r\n<CommentList>\r\n  <Comment ')).toBe(true)
    expect(parseNotes(plan.bytes!).notes.map((n) => n.thread)).toEqual(["0123abcd"])
  })

  it("follows LF files and refuses a file without a closing list", () => {
    const lf = enc.encode('<?xml version="1.0" encoding="utf-8"?>\n<CommentList>\n</CommentList>\n')
    const plan = planNoteAppend(lf, draft)
    expect(plan.ok).toBe(true)
    expect(dec.decode(plan.bytes!)).not.toContain("\r")
    const broken = planNoteAppend(enc.encode("<CommentList>"), draft)
    expect(broken.ok).toBe(false)
    expect(broken.bytes).toBeNull()
  })

  it("generates a thread id and date in Paratext's formats when not given", () => {
    const plan = planNoteAppend(null, { ...draft, thread: undefined, date: undefined })
    expect(plan.note!.thread).toMatch(/^[0-9a-f]{8}$/)
    expect(plan.note!.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}[+-]\d{2}:\d{2}$/)
    expect(paratextDate(new Date(2026, 10, 6, 9, 5, 7, 42))).toMatch(/^2026-11-06T09:05:07\.0420000[+-]\d{2}:\d{2}$/)
    expect(buildNoteXml(draft, "\n").split("\n").filter(Boolean)).toHaveLength(13)
  })
})

describe("notesForUnit", () => {
  const notes = parseNotes(enc.encode(REAL)).notes
  it("matches verse units by reference, spans bridged verses, and skips hidden term notes", () => {
    expect(notesForUnit(notes, "MAT", { kind: "verse", chapter: 1, verse: "2" }).map((n) => n.thread)).toEqual(["afe198a8"])
    expect(notesForUnit(notes, "MAT", { kind: "verse", chapter: 1, verse: "1-3" }).map((n) => n.thread)).toEqual(["afe198a8"])
    expect(notesForUnit(notes, "MAT", { kind: "heading", chapter: 1, verse: "2" })).toEqual([])
    expect(notesForUnit(notes, "2KI", { kind: "verse", chapter: 9, verse: "25" })).toEqual([])
  })
  it("names the per-user file", () => {
    expect(notesFileName("Ryder Wishart")).toBe("Notes_Ryder Wishart.xml")
    expect(isNotesFileName("Notes_Ryder Wishart.xml")).toBe(true)
    expect(isNotesFileName("Notes.xml")).toBe(false)
  })
})
