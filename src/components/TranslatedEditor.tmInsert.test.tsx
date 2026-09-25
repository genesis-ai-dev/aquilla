import { createHash } from "node:crypto"
import type { Editor } from "@tiptap/core"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import { TranslatedEditor, type TranslatedEditorHandle } from "./TranslatedEditor"
import type { IdmlEditorConfiguration } from "@/lib/richtext/idml-editor"

// AQU-1393: the Examples panel's exact-match "Insert" puts the match's existing
// translation into the target. It must land as an ordinary editor edit — through
// the editor's own commit path so the translator can edit or undo it — whether
// the editor was already open (the imperative handle) or still a read view (the
// pending-replace buffer, drained on focus like AQU-746's keystroke buffer).

type EditorSurface = HTMLElement & { editor?: Editor }

afterEach(cleanup)

function idmlFixture() {
  const sourceHtml =
    `<p data-idml-version="2">`
    + `<span data-idml-slot="0" data-idml-character-style="CharacterStyle/Body" data-idml-protected="slot">Source</span>`
    + `</p>`
  const metadata: IdmlFormatMetadataV2 = {
    version: 2,
    slotCount: 1,
    editableSlotIndexes: [0],
    protectedTokenCount: 0,
    anchorSequenceHash: createHash("sha256")
      .update(["slot:0:editable:CharacterStyle/Body"].join(" "))
      .digest("hex"),
  }
  const configuration: IdmlEditorConfiguration = {
    kind: "ready",
    context: { sourceHtml, metadata },
  }
  return { configuration, emptyTargetHtml: sourceHtml.replace(">Source</span>", "></span>") }
}

describe("TranslatedEditor — TM insert (AQU-1393)", () => {
  it("replaces the target and commits it through the normal path", () => {
    const onCommit = vi.fn()
    const handle = createRef<TranslatedEditorHandle>()

    render(
      <TranslatedEditor
        ref={handle}
        cellId="tm-replace"
        initialPlain="a rough draft"
        initialHtml="<p>a rough draft</p>"
        onCommit={onCommit}
      />,
    )

    const surface = document.querySelector(".ProseMirror") as EditorSurface
    let replaced = false
    act(() => {
      replaced = handle.current!.replacePlainText("Au commencement") === true
    })

    expect(replaced).toBe(true)
    expect(surface.editor!.getText()).toBe("Au commencement")
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Au commencement" }),
    )
  })

  it("keeps angle brackets in the inserted text literal rather than parsing markup", () => {
    const onCommit = vi.fn()
    const handle = createRef<TranslatedEditorHandle>()

    render(
      <TranslatedEditor
        ref={handle}
        cellId="tm-literal"
        initialPlain=""
        initialHtml="<p></p>"
        onCommit={onCommit}
      />,
    )

    const surface = document.querySelector(".ProseMirror") as EditorSurface
    act(() => {
      handle.current!.replacePlainText("a < b & c")
    })

    expect(surface.editor!.getText()).toBe("a < b & c")
  })

  it("refuses to write when the editor is read-only", () => {
    const onCommit = vi.fn()
    const handle = createRef<TranslatedEditorHandle>()

    render(
      <TranslatedEditor
        ref={handle}
        cellId="tm-readonly"
        initialPlain="untouched"
        initialHtml="<p>untouched</p>"
        editable={false}
        onCommit={onCommit}
      />,
    )

    const surface = document.querySelector(".ProseMirror") as EditorSurface
    let replaced: boolean | undefined
    act(() => {
      replaced = handle.current!.replacePlainText("Au commencement")
    })

    expect(replaced).toBe(false)
    expect(surface.editor!.getText()).toBe("untouched")
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("refuses to flatten an IDML target, whose slots the export depends on", async () => {
    const { configuration, emptyTargetHtml } = idmlFixture()
    const onCommit = vi.fn()
    const handle = createRef<TranslatedEditorHandle>()

    const { container } = render(
      <TranslatedEditor
        ref={handle}
        cellId="tm-idml"
        initialPlain=""
        initialHtml={emptyTargetHtml}
        idmlConfiguration={configuration}
        onCommit={onCommit}
      />,
    )
    await act(async () => { await Promise.resolve() })

    let replaced: boolean | undefined
    act(() => {
      replaced = handle.current!.replacePlainText("Au commencement")
    })

    expect(replaced).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
    const surface = container.querySelector(".ProseMirror") as EditorSurface
    expect(surface.editor!.getText()).not.toContain("Au commencement")
  })

  it("drains a pending replace on focus, for an insert requested before the editor mounted", () => {
    const onCommit = vi.fn()
    const pendingReplaceRef = createRef<string | null>() as { current: string | null }
    pendingReplaceRef.current = "Au commencement"

    render(
      <TranslatedEditor
        cellId="tm-pending"
        initialPlain="a rough draft"
        initialHtml="<p>a rough draft</p>"
        onCommit={onCommit}
        pendingReplaceRef={pendingReplaceRef}
      />,
    )

    const surface = document.querySelector(".ProseMirror") as EditorSurface
    act(() => {
      fireEvent.focus(surface)
    })

    expect(surface.editor!.getText()).toBe("Au commencement")
    // Drained, so it cannot leak into a later, unrelated activation.
    expect(pendingReplaceRef.current).toBeNull()
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Au commencement" }),
    )
  })

  it("replays buffered keystrokes AFTER the pending replace, so typing is not wiped", () => {
    const onCommit = vi.fn()
    const pendingReplaceRef = createRef<string | null>() as { current: string | null }
    pendingReplaceRef.current = "Au commencement"
    const pendingInputRef = createRef<string>() as { current: string }
    pendingInputRef.current = "!"

    render(
      <TranslatedEditor
        cellId="tm-pending-and-keys"
        initialPlain=""
        initialHtml="<p></p>"
        onCommit={onCommit}
        pendingReplaceRef={pendingReplaceRef}
        pendingInputRef={pendingInputRef}
      />,
    )

    const surface = document.querySelector(".ProseMirror") as EditorSurface
    act(() => {
      fireEvent.focus(surface)
    })

    expect(surface.editor!.getText()).toBe("Au commencement!")
    expect(pendingInputRef.current).toBe("")
  })

  it("leaves the target alone when nothing is pending", () => {
    const onCommit = vi.fn()
    const pendingReplaceRef = createRef<string | null>() as { current: string | null }
    pendingReplaceRef.current = null

    render(
      <TranslatedEditor
        cellId="tm-nothing-pending"
        initialPlain="a rough draft"
        initialHtml="<p>a rough draft</p>"
        onCommit={onCommit}
        pendingReplaceRef={pendingReplaceRef}
      />,
    )

    const surface = document.querySelector(".ProseMirror") as EditorSurface
    act(() => {
      fireEvent.focus(surface)
    })

    expect(surface.editor!.getText()).toBe("a rough draft")
    expect(onCommit).not.toHaveBeenCalled()
  })
})
