// BIA ghost text inside the real TranslatedEditor: the suggestion shows at the
// caret but never reaches a commit until Tab accepts it, and then it commits
// through the ordinary snapshot path. The setting toggle turns it off.

import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import type { Editor } from "@tiptap/core"
import { TranslatedEditor, type TranslatedEditorCommit } from "./TranslatedEditor"
import { ForecastProvider } from "@/context/ForecastContext"
import { BiaEngine } from "@/lib/forecast/bia-engine"
import { createInThreadForecastClient } from "@/lib/forecast/forecast-client"

afterEach(cleanup)

const CORPUS = ["the lord is my shepherd", "the lord is my light", "my shepherd leads me", "the lord is good"]

function client() {
  const engine = new BiaEngine()
  engine.index.upsert(CORPUS.map((text, i) => ({ id: `other-${i}`, text, validated: true })))
  return createInThreadForecastClient(engine)
}

async function mount(ghostTextEnabled: boolean, onNavigateCell?: (direction: "prev" | "next") => void) {
  const commits: TranslatedEditorCommit[] = []
  const view = render(
    <ForecastProvider value={{ client: client(), ghostTextEnabled }}>
      <TranslatedEditor
        cellId="active"
        initialPlain="the lord is"
        onCommit={(snap) => { commits.push(snap) }}
        onNavigateCell={onNavigateCell}
      />
    </ForecastProvider>,
  )
  await act(async () => { await Promise.resolve() })
  const pm = view.container.querySelector(".ProseMirror") as HTMLElement
  const editor = (pm as unknown as { editor: Editor }).editor
  act(() => {
    pm.focus()
    fireEvent.focus(pm)
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.view.dispatch(editor.state.tr.insertText(" "))
  })
  return { ...view, pm, editor, commits }
}

describe("TranslatedEditor — BIA ghost text", () => {
  it("never commits the ghost; Tab accepts it through the normal commit path", async () => {
    const { pm, editor, commits } = await mount(true)
    await waitFor(() => expect(pm.querySelector("[data-testid='ghost-text']")?.textContent).toBe("my shepherd"))

    expect(editor.getText()).toBe("the lord is ")
    act(() => { window.dispatchEvent(new Event("pagehide")) })
    expect(commits.at(-1)?.value).toBe("the lord is ")
    expect(commits.at(-1)?.valueHtml ?? "").not.toContain("shepherd")

    act(() => { fireEvent.keyDown(pm, { key: "Tab" }) })
    expect(editor.getText()).toBe("the lord is my shepherd")
    act(() => { window.dispatchEvent(new Event("pagehide")) })
    expect(commits.at(-1)?.value).toBe("the lord is my shepherd")
  })

  // Regression: in the table the row wires onNavigateCell, whose capture-phase
  // Tab handler used to move to the next cell before the ghost could take Tab.
  it("Tab accepts the ghost instead of moving cells; without a ghost Tab still navigates", async () => {
    const navigations: string[] = []
    const { pm, editor } = await mount(true, (direction) => { navigations.push(direction) })
    await waitFor(() => expect(pm.querySelector("[data-testid='ghost-text']")).not.toBeNull())
    act(() => { fireEvent.keyDown(pm, { key: "Tab" }) })
    expect(editor.getText()).toBe("the lord is my shepherd")
    expect(navigations).toEqual([])

    act(() => { fireEvent.keyDown(pm, { key: "Escape" }) })
    act(() => { fireEvent.keyDown(pm, { key: "Tab" }) })
    expect(navigations).toEqual(["next"])
  })

  it("Esc dismisses the ghost instead of leaving the cell, and writes nothing", async () => {
    const { pm, editor } = await mount(true)
    await waitFor(() => expect(pm.querySelector("[data-testid='ghost-text']")).not.toBeNull())
    act(() => { fireEvent.keyDown(pm, { key: "Escape" }) })
    expect(pm.querySelector("[data-testid='ghost-text']")).toBeNull()
    expect(editor.getText()).toBe("the lord is ")
  })

  it("shows nothing when the setting is off", async () => {
    const { pm } = await mount(false)
    await new Promise((r) => setTimeout(r, 300))
    expect(pm.querySelector("[data-testid='ghost-text']")).toBeNull()
  })
})
