import { describe, it, expect, vi } from "vitest"
import { render, fireEvent, act } from "@testing-library/react"
import { TranslatedEditor } from "./TranslatedEditor"

// AQU-216: Opening a file must not emit phantom revisions.
//
// Legacy-imported cells store HTML-escaped text (e.g. `--&gt;`). On open the
// editor hydrates the *unescaped* form (`-->`) because content is parsed
// through the DOM. The "did the user actually change anything?" dirty-check
// must treat that escaped↔unescaped (load-time normalization) difference as a
// no-op — otherwise merely focusing then blurring a cell commits a revision the
// user never made, which then collides across sessions.

describe("TranslatedEditor — no phantom commit on open (AQU-216)", () => {
  it("does not commit when an escaped legacy value is opened and blurred without editing", () => {
    const onCommit = vi.fn()
    // Stored value as legacy-import wrote it: HTML-escaped arrow.
    const escaped = "00:01:02,312 --&gt; 00:01:06,108"

    render(
      <TranslatedEditor
        cellId="cell-1"
        initialPlain={escaped}
        initialHtml={`<p>${escaped}</p>`}
        onCommit={onCommit}
      />,
    )

    const surface = document.querySelector(".ProseMirror") as HTMLElement
    expect(surface).toBeTruthy()

    // Focus then blur the cell — the classic "PM just opened it to look" path.
    act(() => {
      fireEvent.focus(surface)
      fireEvent.blur(surface)
    })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it("still commits a genuine user edit", () => {
    const onCommit = vi.fn()
    render(
      <TranslatedEditor
        cellId="cell-2"
        initialPlain="hello"
        initialHtml="<p>hello</p>"
        onCommit={onCommit}
      />,
    )

    // The ProseMirror DOM node exposes the live TipTap editor — drive a real
    // content change through it (reliable under happy-dom, unlike synthetic
    // keystrokes), then blur to flush the commit.
    const surface = document.querySelector(".ProseMirror") as HTMLElement & {
      editor?: { commands: { insertContent: (s: string) => void } }
    }
    expect(surface.editor).toBeTruthy()

    act(() => {
      fireEvent.focus(surface)
      surface.editor!.commands.insertContent(" world")
      fireEvent.blur(surface)
    })

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0].value).toContain("world")
  })
})
