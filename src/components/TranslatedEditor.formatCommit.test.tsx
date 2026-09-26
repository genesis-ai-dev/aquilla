/**
 * A formatting-only edit is still an edit.
 *
 * The commit paths used to compare plain text alone, so bolding or
 * underlining a word — which changes the HTML and nothing else — looked
 * identical to "no change" and was dropped on blur. The user watched their
 * formatting disappear the moment they left the cell.
 */

import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, act, waitFor, fireEvent } from "@testing-library/react"
import type { Editor } from "@tiptap/react"
import { TranslatedEditor } from "./TranslatedEditor"

afterEach(cleanup)

type EditorSurface = HTMLElement & { editor?: Editor }

async function mountEditor(onCommit: (snap: { value: string; valueHtml: string }) => void) {
  const { container } = render(
    <TranslatedEditor cellId="cell-format" initialPlain="hello world" onCommit={onCommit} />,
  )
  const surface = await waitFor(() => {
    const el = container.querySelector(".ProseMirror") as EditorSurface | null
    if (!el?.editor) throw new Error("editor not mounted yet")
    return el
  })
  return { surface, editor: surface.editor! }
}

describe("TranslatedEditor — formatting-only edits", () => {
  it("commits a bold-only change on blur", async () => {
    const commits: { value: string; valueHtml: string }[] = []
    const { surface, editor } = await mountEditor((snap) => commits.push(snap))

    act(() => {
      editor.commands.focus()
      editor.commands.selectAll()
      editor.commands.toggleBold()
    })
    fireEvent.blur(surface)

    await waitFor(() => expect(commits).toHaveLength(1))
    // The plain text is deliberately unchanged — that is the whole point.
    expect(commits[0].value).toBe("hello world")
    expect(commits[0].valueHtml).toContain("<strong>")
  })

  it("commits an underline-only change on blur", async () => {
    const commits: { value: string; valueHtml: string }[] = []
    const { surface, editor } = await mountEditor((snap) => commits.push(snap))

    act(() => {
      editor.commands.focus()
      editor.commands.selectAll()
      editor.commands.toggleUnderline()
    })
    fireEvent.blur(surface)

    await waitFor(() => expect(commits).toHaveLength(1))
    expect(commits[0].valueHtml).toMatch(/<u>|text-decoration/)
  })

  it("still commits nothing when the user only looks at the cell", async () => {
    // The dirty check has to stay a dirty check: opening and leaving a cell
    // must not write a phantom revision (AQU-216).
    const commits: { value: string; valueHtml: string }[] = []
    const { surface } = await mountEditor((snap) => commits.push(snap))

    fireEvent.blur(surface)

    await act(async () => {
      await Promise.resolve()
    })
    expect(commits).toHaveLength(0)
  })

  it("does not re-commit formatting that is already committed", async () => {
    const commits: { value: string; valueHtml: string }[] = []
    const { surface, editor } = await mountEditor((snap) => commits.push(snap))

    act(() => {
      editor.commands.focus()
      editor.commands.selectAll()
      editor.commands.toggleBold()
    })
    fireEvent.blur(surface)
    await waitFor(() => expect(commits).toHaveLength(1))

    act(() => {
      editor.commands.focus()
    })
    fireEvent.blur(surface)

    await act(async () => {
      await Promise.resolve()
    })
    expect(commits).toHaveLength(1)
  })
})
