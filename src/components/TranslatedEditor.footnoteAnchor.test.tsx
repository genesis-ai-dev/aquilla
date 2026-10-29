// AQU-2173: where a footnote lands when the rail takes focus off the editor.
//
// Every footnote action lives behind the row's `⋯` overflow (AQU-200), and
// opening that menu blurs the cell editor. The anchor therefore has to be
// readable from an editor that is no longer focused — otherwise the marker goes
// to the end of the cell with nothing prefilled, which is the whole bug. The
// one case that still belongs at the end of the cell is an editor the user
// never had a caret in at all (the rail reached by hover alone).

import type { Editor } from "@tiptap/core"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { TranslatedEditor, type TranslatedEditorHandle } from "./TranslatedEditor"
import { insertFootnoteMarkerAtAnchor } from "@/lib/footnotes/splice"

type EditorSurface = HTMLElement & { editor?: Editor }

afterEach(cleanup)

function renderEditor(initialPlain: string) {
  const handle = createRef<TranslatedEditorHandle>()
  render(
    <TranslatedEditor
      ref={handle}
      cellId="footnote-anchor"
      initialPlain={initialPlain}
      initialHtml={`<p>${initialPlain}</p>`}
      onCommit={() => { /* no-op */ }}
    />,
  )
  const surface = document.querySelector(".ProseMirror") as EditorSurface
  return { handle, surface, editor: surface.editor! }
}

describe("TranslatedEditor — footnote anchor across a rail blur (AQU-2173)", () => {
  it("keeps a selected phrase as the anchor after the editor loses focus", () => {
    const { handle, surface, editor } = renderEditor("au commencement Dieu créa")
    const from = "au ".length + 1
    const to = from + "commencement".length

    act(() => {
      fireEvent.focus(surface)
      editor.commands.setTextSelection({ from, to })
    })
    // What opening the `⋯` does: focus leaves the editor, the selection it was
    // holding does not.
    act(() => { fireEvent.blur(surface) })
    expect(editor.isFocused).toBe(false)

    const anchor = handle.current!.getFootnoteInsertionAnchor()
    expect(anchor?.source).toBe("selection")
    expect(anchor?.previewText).toBe("commencement")
    expect(anchor?.position).toBe(to)
  })

  it("anchors at the caret's word when nothing is selected", () => {
    const { handle, surface, editor } = renderEditor("au commencement Dieu créa")
    const caret = "au comm".length + 1

    act(() => {
      fireEvent.focus(surface)
      editor.commands.setTextSelection(caret)
    })
    act(() => { fireEvent.blur(surface) })
    expect(editor.isFocused).toBe(false)

    const anchor = handle.current!.getFootnoteInsertionAnchor()
    expect(anchor?.source).toBe("word")
    expect(anchor?.previewText).toBe("commencement")
  })

  it("still anchors at the end of the cell for an editor the user never focused", () => {
    const { handle, editor } = renderEditor("au commencement Dieu créa")

    expect(editor.isFocused).toBe(false)
    const anchor = handle.current!.getFootnoteInsertionAnchor()
    expect(anchor?.source).toBe("end")
  })
})

// AQU-2206: the anchor above is only half the journey. The dialog's text field
// pulls focus out of the cell, the row deactivates it and unmounts the editor,
// so the insertion runs against the STORED text instead of the live document —
// and that path used to append the marker, which sent every footnote to the end
// of the cell however good the anchor was. These pass a REAL anchor from the
// editor through the real stored-text insertion, which is where the two halves
// have to agree.
describe("TranslatedEditor anchor → stored-text insertion (AQU-2206)", () => {
  const MARKER = "\\f + \\fr 1:1 \\ft commencement: note\\f*"

  function anchorAfterBlur(initialPlain: string, setSelection: (editor: Editor) => void) {
    const { handle, surface, editor } = renderEditor(initialPlain)
    act(() => {
      fireEvent.focus(surface)
      setSelection(editor)
    })
    // Opening the `⋯`, then the dialog's autofocused field: focus leaves the cell.
    act(() => { fireEvent.blur(surface) })
    return handle.current!.getFootnoteInsertionAnchor()
  }

  it("puts the marker after the selected phrase, matching the dialog's preview", () => {
    const stored = "au commencement Dieu créa"
    const from = "au ".length + 1
    const anchor = anchorAfterBlur(stored, (editor) => {
      editor.commands.setTextSelection({ from, to: from + "commencement".length })
    })

    expect(insertFootnoteMarkerAtAnchor(stored, MARKER, anchor))
      .toBe(`au commencement${MARKER} Dieu créa`)
    // The dialog renders previewBefore + marker + previewAfter, so the result
    // the user gets is the preview they were shown.
    expect(insertFootnoteMarkerAtAnchor(stored, MARKER, anchor))
      .toBe(`${anchor!.previewBefore}${MARKER}${anchor!.previewAfter}`)
  })

  it("puts the marker after the caret's word when nothing is selected", () => {
    const stored = "au commencement Dieu créa"
    const anchor = anchorAfterBlur(stored, (editor) => {
      editor.commands.setTextSelection("au comm".length + 1)
    })

    expect(anchor?.source).toBe("word")
    expect(insertFootnoteMarkerAtAnchor(stored, MARKER, anchor))
      .toBe(`au commencement${MARKER} Dieu créa`)
  })

  it("still lands at the end of the cell for a row the user never focused", () => {
    const stored = "au commencement Dieu créa"
    const { handle } = renderEditor(stored)
    const anchor = handle.current!.getFootnoteInsertionAnchor()

    expect(anchor?.source).toBe("end")
    expect(insertFootnoteMarkerAtAnchor(stored, MARKER, anchor)).toBe(`${stored}${MARKER}`)
  })
})
