import { createHash } from "node:crypto"
import type { Editor } from "@tiptap/core"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { validateIdmlTranslation, type IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import { TranslatedEditor } from "./TranslatedEditor"
import type { IdmlEditorConfiguration } from "@/lib/richtext/idml-editor"

const SOURCE_HTML =
  `<p data-idml-version="2">`
  + `<span data-idml-slot="0" data-idml-character-style="CharacterStyle/Body" data-idml-protected="slot">Source</span>`
  + `<span data-idml-token="0" data-idml-token-kind="tab" data-idml-protected="token" contenteditable="false"></span>`
  + `<span data-idml-slot="1" data-idml-character-style="CharacterStyle/Bold" data-idml-protected="slot">Second</span>`
  + `</p>`

const METADATA: IdmlFormatMetadataV2 = {
  version: 2,
  slotCount: 2,
  editableSlotIndexes: [0, 1],
  protectedTokenCount: 1,
  anchorSequenceHash: createHash("sha256").update([
    "slot:0:editable:CharacterStyle/Body",
    "token:0:tab",
    "slot:1:editable:CharacterStyle/Bold",
  ].join("\u0000")).digest("hex"),
}

const CONFIGURATION: IdmlEditorConfiguration = {
  kind: "ready",
  context: { sourceHtml: SOURCE_HTML, metadata: METADATA },
}

type EditorSurface = HTMLElement & { editor?: Editor }

function positionOf(editor: Editor, name: string): number {
  let position = -1
  editor.state.doc.descendants((node, currentPosition) => {
    if (position >= 0) return false
    if (node.type.name !== name) return true
    position = currentPosition
    return false
  })
  if (position < 0) throw new Error(`Missing ${name}`)
  return position
}

afterEach(cleanup)

describe("TranslatedEditor — protected IDML mode", () => {
  it("places the caret inside an empty protected slot when the editor is activated", async () => {
    const onCommit = vi.fn()
    const emptyTargetHtml = SOURCE_HTML
      .replace(">Source</span>", "></span>")
      .replace(">Second</span>", "></span>")
    const { container } = render(
      <TranslatedEditor
        cellId="idml-empty-activation"
        initialPlain=""
        initialHtml={emptyTargetHtml}
        idmlConfiguration={CONFIGURATION}
        onCommit={onCommit}
      />,
    )
    await act(async () => { await Promise.resolve() })
    const surface = container.querySelector(".ProseMirror") as EditorSurface
    const editor = surface.editor!
    act(() => {
      fireEvent.focus(surface)
      fireEvent.click(surface)
    })
    expect(editor.state.selection.$from.parent.type.name).toBe("idmlSlot")
    expect(editor.state.selection.$from.parent.attrs.editable).toBe(true)

    act(() => {
      for (const character of "Translated") {
        fireEvent.keyDown(surface, { key: character })
      }
      fireEvent.click(surface.querySelector("span[data-idml-slot=\"1\"]")!)
      fireEvent.keyDown(surface, { key: "B" })
      fireEvent.blur(surface)
    })
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({
      value: "Translated\tB",
      valueHtml: expect.stringMatching(/>Translated<\/span>.*>B<\/span>/),
    }))
    const committed = onCommit.mock.calls[0][0] as { valueHtml: string }
    expect(validateIdmlTranslation(SOURCE_HTML, committed.valueHtml, METADATA).valid).toBe(true)
  })

  it("keeps forward caret order after a native collapse-to-end focus (EditorTable path)", async () => {
    // EditorTable used to focus IDML cells with selectNodeContents + collapse(false).
    // On empty protected slots that paints the caret on a phantom second line and
    // desyncs ProseMirror — each keystroke then prepends, producing reverse text.
    const onCommit = vi.fn()
    const emptyTargetHtml = SOURCE_HTML
      .replace(">Source</span>", "></span>")
      .replace(">Second</span>", "></span>")
    const { container } = render(
      <TranslatedEditor
        cellId="idml-native-end-focus"
        initialPlain=""
        initialHtml={emptyTargetHtml}
        idmlConfiguration={CONFIGURATION}
        onCommit={onCommit}
      />,
    )
    await act(async () => { await Promise.resolve() })
    const surface = container.querySelector(".ProseMirror") as EditorSurface
    const editor = surface.editor!

    act(() => {
      fireEvent.focus(surface)
      const sel = window.getSelection()
      if (sel) {
        const range = document.createRange()
        range.selectNodeContents(surface)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
      }
      for (const character of "abc") {
        fireEvent.keyDown(surface, { key: character })
      }
      fireEvent.blur(surface)
    })

    expect(editor.getText()).toBe("abc\t")
    expect(surface.querySelector("span[data-idml-slot=\"0\"]")?.textContent).toBe("abc")
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({
      value: "abc\t",
      valueHtml: expect.stringContaining(">abc</span>"),
    }))
  })

  it("appends to a populated slot when read-view activation has no pointer selection", async () => {
    const onCommit = vi.fn()
    const targetHtml = SOURCE_HTML.replace(">Source</span>", ">asd</span>")
    const { container } = render(
      <TranslatedEditor
        cellId="idml-populated-activation"
        initialPlain={"asd\tSecond"}
        initialHtml={targetHtml}
        idmlConfiguration={CONFIGURATION}
        onCommit={onCommit}
      />,
    )
    await act(async () => { await Promise.resolve() })
    const surface = container.querySelector(".ProseMirror") as EditorSurface
    const editor = surface.editor!

    act(() => {
      fireEvent.focus(surface)
      for (const character of "123") {
        fireEvent.keyDown(surface, { key: character })
      }
      fireEvent.blur(surface)
    })

    expect(editor.getText()).toBe("asd123\tSecond")
    expect(surface.querySelector("span[data-idml-slot=\"0\"]")?.textContent).toBe("asd123")
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({
      value: "asd123\tSecond",
      valueHtml: expect.stringContaining(">asd123</span>"),
    }))
  })

  it("pastes Unicode and line breaks into an empty slot without importing clipboard markup", async () => {
    const onCommit = vi.fn()
    const emptyTargetHtml = SOURCE_HTML
      .replace(">Source</span>", "></span>")
      .replace(">Second</span>", "></span>")
    const { container } = render(
      <TranslatedEditor
        cellId="idml-empty-paste"
        initialPlain=""
        initialHtml={emptyTargetHtml}
        idmlConfiguration={CONFIGURATION}
        onCommit={onCommit}
      />,
    )
    await act(async () => { await Promise.resolve() })
    const surface = container.querySelector(".ProseMirror") as EditorSurface

    act(() => {
      fireEvent.focus(surface)
      fireEvent.paste(surface, {
        clipboardData: {
          types: ["text/html", "text/plain"],
          files: [],
          items: [],
          getData: (type: string) => type === "text/html"
            ? "<script>bad()</script><strong>漢字</strong><br>नमस्ते"
            : "漢字\r\nनमस्ते",
        },
      })
      fireEvent.blur(surface)
    })

    const slotElement = surface.querySelector("span[data-idml-slot=\"0\"]")
    expect(slotElement?.textContent).toBe("漢字नमस्ते")
    expect(slotElement?.querySelector("br")).toBeTruthy()
    expect(slotElement?.querySelector("strong, script")).toBeNull()
    const committed = onCommit.mock.calls[0]?.[0] as { valueHtml: string } | undefined
    expect(committed?.valueHtml).toContain("漢字<br>नमस्ते")
    expect(validateIdmlTranslation(SOURCE_HTML, committed!.valueHtml, METADATA).valid).toBe(true)
  })

  it("replaces in-progress IME composition text instead of duplicating it", async () => {
    const onCommit = vi.fn()
    const emptyTargetHtml = SOURCE_HTML
      .replace(">Source</span>", "></span>")
      .replace(">Second</span>", "></span>")
    const { container } = render(
      <TranslatedEditor
        cellId="idml-ime"
        initialPlain=""
        initialHtml={emptyTargetHtml}
        idmlConfiguration={CONFIGURATION}
        onCommit={onCommit}
      />,
    )
    await act(async () => { await Promise.resolve() })
    const surface = container.querySelector(".ProseMirror") as EditorSurface

    act(() => {
      fireEvent.focus(surface)
      fireEvent.compositionStart(surface)
      fireEvent(surface, new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "漢",
        inputType: "insertCompositionText",
      }))
      fireEvent(surface, new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: "漢字",
        inputType: "insertCompositionText",
      }))
      fireEvent.compositionEnd(surface, { data: "漢字" })
      fireEvent.blur(surface)
    })

    expect(surface.querySelector("span[data-idml-slot=\"0\"]")?.textContent).toBe("漢字")
    const committed = onCommit.mock.calls[0]?.[0] as { valueHtml: string } | undefined
    expect(committed?.valueHtml).toContain(">漢字</span>")
    expect(validateIdmlTranslation(SOURCE_HTML, committed!.valueHtml, METADATA).valid).toBe(true)
  })

  it("keeps Enter inside the current slot and commits validator-approved HTML", async () => {
    const onCommit = vi.fn()
    const onEscapeToGrid = vi.fn()
    const { container } = render(
      <TranslatedEditor
        cellId="idml-enter"
        initialPlain="Source\tSecond"
        initialHtml={SOURCE_HTML}
        idmlConfiguration={CONFIGURATION}
        onCommit={onCommit}
        onEscapeToGrid={onEscapeToGrid}
      />,
    )
    await act(async () => { await Promise.resolve() })
    const surface = container.querySelector(".ProseMirror") as EditorSurface
    const editor = surface.editor!
    const slotPosition = positionOf(editor, "idmlSlot")
    const slot = editor.state.doc.nodeAt(slotPosition)!

    act(() => {
      editor.commands.setTextSelection(slotPosition + 1 + slot.content.size)
      fireEvent.keyDown(surface, { key: "Enter", code: "Enter" })
    })

    expect(onEscapeToGrid).not.toHaveBeenCalled()
    expect(surface.querySelectorAll("p[data-idml-version=\"2\"]")).toHaveLength(1)
    expect(surface.querySelector("span[data-idml-slot=\"0\"] br")).toBeTruthy()
    expect(
      (surface.querySelector("span[data-idml-slot=\"1\"]") as HTMLElement).style.fontWeight,
    ).toBe("700")

    act(() => fireEvent.blur(surface))
    expect(onCommit).toHaveBeenCalledTimes(1)
    const committed = onCommit.mock.calls[0][0] as { valueHtml: string }
    expect(validateIdmlTranslation(SOURCE_HTML, committed.valueHtml, METADATA).valid).toBe(true)
  })

  it("rejects an anchor deletion, shows an actionable error, and emits no commit", async () => {
    const onCommit = vi.fn()
    const onIdmlValidationError = vi.fn()
    const { container } = render(
      <TranslatedEditor
        cellId="idml-delete"
        initialPlain="Source\tSecond"
        initialHtml={SOURCE_HTML}
        idmlConfiguration={CONFIGURATION}
        onCommit={onCommit}
        onIdmlValidationError={onIdmlValidationError}
      />,
    )
    await act(async () => { await Promise.resolve() })
    const surface = container.querySelector(".ProseMirror") as EditorSurface
    const editor = surface.editor!
    const tokenPosition = positionOf(editor, "idmlToken")
    const token = editor.state.doc.nodeAt(tokenPosition)!

    act(() => {
      editor.view.dispatch(
        editor.state.tr.delete(tokenPosition, tokenPosition + token.nodeSize),
      )
    })

    expect(surface.querySelector("[data-idml-token=\"0\"]")).toBeTruthy()
    expect(onIdmlValidationError).toHaveBeenCalledWith(
      expect.stringMatching(/remove protected InDesign formatting/i),
    )
    act(() => fireEvent.blur(surface))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("pastes ordinary rich HTML as slot text without importing markup or anchors", async () => {
    const onCommit = vi.fn()
    const { container } = render(
      <TranslatedEditor
        cellId="idml-paste"
        initialPlain="Source\tSecond"
        initialHtml={SOURCE_HTML}
        idmlConfiguration={CONFIGURATION}
        onCommit={onCommit}
      />,
    )
    await act(async () => { await Promise.resolve() })
    const surface = container.querySelector(".ProseMirror") as EditorSurface
    const editor = surface.editor!
    const slotPosition = positionOf(editor, "idmlSlot")
    const slot = editor.state.doc.nodeAt(slotPosition)!
    editor.commands.setTextSelection(slotPosition + 1 + slot.content.size)

    act(() => {
      fireEvent.paste(surface, {
        clipboardData: {
          types: ["text/html", "text/plain"],
          files: [],
          items: [],
          getData: (type: string) => type === "text/html"
            ? "<strong> Pasted&nbsp;text</strong>"
            : " Pasted\u00a0text",
        },
      })
    })

    const slotElement = surface.querySelector("span[data-idml-slot=\"0\"]")
    expect(slotElement?.textContent).toContain("Pasted\u00a0text")
    expect(slotElement?.querySelector("strong")).toBeNull()
    expect(surface.querySelectorAll("[data-idml-slot]")).toHaveLength(2)
    act(() => fireEvent.blur(surface))
    const committed = onCommit.mock.calls[0]?.[0] as { valueHtml: string } | undefined
    expect(committed).toBeTruthy()
    expect(validateIdmlTranslation(SOURCE_HTML, committed!.valueHtml, METADATA).valid).toBe(true)
  })
})
