// AQU-2559: a Bible book not imported as USFM opens in the document too, but
// its layout must stay fixed. Added layout is stored as USFM markers in the
// verse's value (decision 0010) and only the USFM export reads them; a Word or
// InDesign export would print `\p` and `\s1` into the translator's book.
import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { buildDoc, layoutOf } from "./doc-model"
import { bibleDocumentExtensions, insertHeading, setParagraphMarker, type BibleDocumentRejection } from "./editor-extensions"
import { readPm } from "./pm-helpers"
import type { DocUnit } from "./units"

function unit(cellId: string, verse: number, target: string): DocUnit {
  return {
    cellId,
    kind: "verse",
    ref: `GEN 1:${verse}`,
    chapter: 1,
    label: String(verse),
    headingMarker: null,
    source: `Source ${verse}`,
    sourceParagraphStart: verse === 1,
    sourceParagraphMarker: verse === 1 ? "p" : null,
    target,
  }
}

const UNITS = [unit("a", 1, "Un"), unit("b", 2, "Deux")]
let editor: Editor | null = null

function mount(layoutEditable: boolean) {
  const rejected: BibleDocumentRejection[] = []
  const layout = layoutOf(UNITS)
  editor = new Editor({
    extensions: bibleDocumentExtensions({
      layout: () => layout,
      editable: () => true,
      layoutEditable: () => layoutEditable,
      lockedBy: () => null,
      activeCellId: () => null,
      ghost: () => "",
      onRejected: (reason) => rejected.push(reason),
    }),
    content: buildDoc(UNITS),
  })
  const values = () => readPm(editor!.state.doc, layout).values
  /** Put the caret just after the word "Deux". */
  const caretInVerse2 = () => {
    let at = -1
    editor!.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes("Deux")) at = pos + node.text.indexOf("Deux") + 2
    })
    editor!.view.dispatch(editor!.state.tr.setSelection(TextSelection.create(editor!.state.doc, at)))
    return at
  }
  return { rejected, values, caretInVerse2 }
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe("layout lock", () => {
  it("lets the words of a non-USFM book change", () => {
    const { values, caretInVerse2, rejected } = mount(false)
    const at = caretInVerse2()
    editor!.view.dispatch(editor!.state.tr.insertText("x", at))
    expect(values().get("b")).toBe("Dexux")
    expect(rejected).toEqual([])
  })

  it("refuses a paragraph break, a heading or a style in a non-USFM book, so no marker reaches its values", () => {
    const { values, caretInVerse2, rejected } = mount(false)
    const before = new Map(values())

    const at = caretInVerse2()
    editor!.view.dispatch(editor!.state.tr.split(at))
    insertHeading(editor!.view)
    setParagraphMarker(editor!.view, "q1")

    expect(values()).toEqual(before)
    for (const value of values().values()) expect(value).not.toMatch(/\\[a-z]/)
    expect(rejected).toContain("layout")
  })

  it("still lets a USFM book take a paragraph break, written as a lead", () => {
    const { values, caretInVerse2, rejected } = mount(true)
    const at = caretInVerse2()
    editor!.view.dispatch(editor!.state.tr.split(at))
    expect(values().get("b")).toMatch(/\\p/)
    expect(rejected).not.toContain("layout")
  })
})
