// A reader must be able to tell what a translator marked up: a key term, a
// glossary word, a proper name, a table. The reading page follows the look of
// the shared scripture editor Paratext 10 uses, so a book reads the same in
// both. None of these markers may reach the page as raw text, and none may be
// flattened to plain words either.
import { describe, it, expect } from "vitest"
import { blockClass, cellLines, createNoteCollector, isTableRow, lineInlineHtml } from "./html-blocks"

const inline = (raw: string) => {
  const notes = createNoteCollector("s")
  const html = cellLines(raw).lines.map((line) => lineInlineHtml(line, notes)).join("\n")
  return { html, notes: notes.listHtml() }
}

describe("character markers a reader should see", () => {
  it("marks a key term, and says what it is on hover", () => {
    const { html } = inline("the \\k covenant\\k* of God")
    expect(html).toBe('the <span class="key-term" title="Key term">covenant</span> of God')
  })

  it("marks a glossary word and shows its lemma and Strong's number on hover, never as text", () => {
    const { html } = inline('by \\w grace|lemma="charis" strong="G5485"\\w* alone')
    expect(html).toBe('by <span class="glossary-word" title="Glossary word (lemma: charis, strong: G5485)">grace</span> alone')
    expect(html).not.toContain("|")
  })

  it("shows a glossary word's bare default attribute as its lemma", () => {
    expect(inline("\\w gracious|grace\\w*").html).toContain('title="Glossary word (grace)"')
  })

  it.each([
    ["\\pn David\\pn*", "proper-name"],
    ["\\png Jordan\\png*", "place-name"],
    ["\\qt It is written\\qt*", "quoted-text"],
    ["\\tl Abba\\tl*", "c-italic"],
    ["\\bk Genesis\\bk*", "c-italic"],
    ["\\sig Paul\\sig*", "c-italic"],
    ["\\qs Selah\\qs*", "selah"],
    ["\\ord st\\ord*", "ordinal"],
    ["\\jmp see here|link-href=\"x\"\\jmp*", "link-text"],
    ["\\vp 1a\\vp*", "alt-number"],
    ["\\fig A caption|src=\"a.jpg\" size=\"col\"\\fig*", "figure-caption"],
  ])("%s gets its own style", (raw, cls) => {
    const { html } = inline(`He said ${raw} then.`)
    expect(html).toContain(`<span class="${cls}"`)
    expect(html).not.toContain("\\")
    expect(html).not.toContain("src=")
  })

  it("sets a ruby gloss above its base text", () => {
    expect(inline('\\rb 哀|gloss="あい"\\rb*').html).toBe("<ruby>哀<rt>あい</rt></ruby>")
  })

  it("keeps the styling of a marker nested inside another", () => {
    const { html } = inline("\\wj I am the \\+k bread\\+k* of life\\wj*")
    expect(html).toContain('<span class="wj"><span class="key-term" title="Key term">bread</span></span>')
  })

  it("escapes attribute text a translator typed", () => {
    expect(inline('\\w x|lemma="<b>&quot;"\\w*').html).not.toContain("<b>")
  })
})

describe("milestones and levelled markers leave nothing behind", () => {
  it.each([
    ['\\qt1-s |who="Pilate"\\*What is truth?\\qt1-e\\*', "What is truth?"],
    ["\\qt-s\\*Go\\qt-e\\*", "Go"],
    ["before\\ts\\* after", "before after"],
  ])("%s", (raw, text) => {
    expect(inline(raw).html).toBe(text)
  })
})

describe("a note's own markers", () => {
  it("sets the quoted words and a keyword apart from the explanation, in the notes list", () => {
    const { notes } = inline("light\\f + \\fr 1:3 \\fk Light \\fq let there be \\ft Or \\fqa may there be\\f*")
    expect(notes).toContain('<span class="note-keyword">Light </span>')
    expect(notes).toContain('<span class="note-quote">let there be </span>Or <span class="note-quote">may there be</span>')
    expect(notes).not.toContain("\\")
  })

  it("starts a further paragraph of a note on its own line", () => {
    expect(inline("x\\f + \\ft First. \\fp Second.\\f*").notes).toContain("First. <br>Second.")
  })

  it("shows the note's text when the reader hovers its marker", () => {
    expect(inline("light\\f + \\fr 1:3 \\ft Or lamp\\f*").html).toContain('title="Or lamp"')
  })
})

describe("tables", () => {
  const row = cellLines("\\tr \\th1 Tribe \\thr2 Number\n\\tr \\tc1 Reuben \\tcr2 46,500")

  it("keeps each row on its own line and each cell apart, with headings and right-aligned numbers", () => {
    expect(row.lines).toHaveLength(2)
    expect(row.lines.every(isTableRow)).toBe(true)
    expect(lineInlineHtml(row.lines[0])).toBe('<span class="table-cell table-head">Tribe</span><span class="table-cell table-head cell-right">Number</span>')
    expect(lineInlineHtml(row.lines[1])).toBe('<span class="table-cell">Reuben</span><span class="table-cell cell-right">46,500</span>')
  })

  it("does not read a column span as text", () => {
    expect(lineInlineHtml(cellLines("\\tr \\tc1-2 Total \\tcr3 603,550").lines[0])).not.toContain("-2")
  })

  it("leaves ordinary prose alone", () => {
    expect(isTableRow(cellLines("\\k term\\k* in prose").lines[0])).toBe(false)
  })
})

describe("paragraph styles the page did not have", () => {
  it.each([
    ["pm", "para para-inset"],
    ["pmo", "para para-flush para-inset"],
    ["pmr", "para para-right para-inset"],
    ["cls", "para para-right"],
    ["qd", "para para-flush poetry-note"],
    ["io2", "para list list-2"],
    ["ph1", "para para-hanging para-indent-1"],
    ["lf", "para para-flush"],
  ])("\\%s", (marker, cls) => {
    expect(blockClass(marker, 0)).toBe(cls)
  })
})
