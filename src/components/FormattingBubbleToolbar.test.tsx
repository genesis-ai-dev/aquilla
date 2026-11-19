/**
 * AQU-2654: the selection bubble's buttons subscribe to what they draw.
 *
 * They used to be re-rendered — with the whole editor component — on every
 * ProseMirror transaction. The contract now: nothing is mounted while the
 * selection is collapsed (the bubble is hidden then), typing does not render
 * the toolbar, and the pressed state still follows the selection's marks.
 *
 * UI-only: covered here in RTL, no smoke spec (AGENTS.md testing rule 3).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { Profiler } from "react"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { FormattingBubbleToolbar } from "./FormattingBubbleToolbar"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { TooltipProvider } from "@/components/ui/tooltip"

let editor: Editor | null = null

function mount() {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit],
    content: "<p>hello world</p>",
  })
  const onRender = vi.fn()
  render(
    <I18nProvider>
      <TooltipProvider>
        <Profiler id="toolbar" onRender={onRender}>
          <FormattingBubbleToolbar editor={editor} onMouseDown={() => {}} cellId="cell-1" />
        </Profiler>
      </TooltipProvider>
    </I18nProvider>,
  )
  return { editor, onRender }
}

afterEach(() => {
  cleanup()
  editor?.destroy()
  editor = null
})

const pressed = (name: string) =>
  screen.getByRole("button", { name }).className.split(/\s+/).includes("bg-accent")

describe("FormattingBubbleToolbar (AQU-2654)", () => {
  it("mounts no buttons while the selection is collapsed, and typing does not render it", () => {
    const { editor, onRender } = mount()
    expect(screen.queryByTestId("formatting-bubble-menu")).toBeNull()
    const before = onRender.mock.calls.length

    act(() => {
      editor.commands.setTextSelection(6)
      editor.commands.insertContent("a")
      editor.commands.insertContent("b")
      editor.commands.setTextSelection(3)
    })

    expect(editor.getText()).toBe("helloab world")
    expect(screen.queryByTestId("formatting-bubble-menu")).toBeNull()
    expect(onRender.mock.calls.length).toBe(before)
  })

  it("shows the five mark buttons over a selection and follows the marks on it", () => {
    const { editor } = mount()
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }) })

    expect(screen.getByTestId("formatting-bubble-menu")).toBeInTheDocument()
    for (const name of ["Bold", "Italic", "Underline", "Strikethrough"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument()
    }
    expect(pressed("Bold")).toBe(false)

    act(() => { editor.chain().toggleBold().run() })
    expect(pressed("Bold")).toBe(true)
    expect(pressed("Italic")).toBe(false)

    // The button itself runs the same command.
    act(() => { screen.getByRole("button", { name: "Italic" }).click() })
    expect(pressed("Italic")).toBe(true)
    expect(editor.getHTML()).toContain("<em>")

    // Collapsing the selection hides the bubble, and the buttons with it.
    act(() => { editor.commands.setTextSelection(2) })
    expect(screen.queryByTestId("formatting-bubble-menu")).toBeNull()
  })

  it("does not re-render while a selection moves without changing what is drawn", () => {
    const { editor, onRender } = mount()
    act(() => { editor.commands.setTextSelection({ from: 1, to: 4 }) })
    const before = onRender.mock.calls.length
    act(() => { editor.commands.setTextSelection({ from: 2, to: 5 }) })
    // Same answer (a selection, no marks): the buttons were not rendered again.
    // The thesaurus button is absent here (no forecast client), so nothing
    // else in the toolbar reads the selection either.
    expect(onRender.mock.calls.length).toBe(before)
  })
})
