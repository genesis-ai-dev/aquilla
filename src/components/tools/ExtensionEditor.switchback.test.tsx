import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolSummary } from "@/lib/tools/tools-api"
import { editorChoiceKey } from "@/lib/tools/editor-choice"
import { expectClickNote } from "@/test-utils/tooltip"

/**
 * Native "Aquilla editor" is always the default. Any user can opt into an
 * installed custom editor extension per file or project-wide from the one
 * "Edit with" menu, and switch back to the native editor with one pick —
 * local, remembered choices no role or extension permission can block. The
 * native editor also opens automatically when a custom editor fails to load.
 */

const EXT: ToolSummary = {
  id: "custom-editor",
  name: "Focus Editor",
  firstParty: null,
  manifest: { name: "Focus Editor", description: "One verse at a time", scopes: ["read:cells"], mounts: ["page", "editor"], apiRev: 5, sdk: 1 },
} as unknown as ToolSummary

const ctx = {
  projectId: "p1",
  tools: [EXT],
  toolsReady: true,
  session: { jwt: "j", username: "carol" },
}

vi.mock("./ToolsMountContext", () => ({ useToolsMount: () => ctx, useMountedTool: () => ({ tool: null, error: null }) }))

const { useExtensionEditorChoice, ExtensionEditorSwitcher, ExtensionEditorFallbackNotice } = await import("./ExtensionEditor")

function Harness({ fileId = "f1" }: { fileId?: string }) {
  const choice = useExtensionEditorChoice("carol", "p1", fileId)
  return (
    <MemoryRouter>
      <ExtensionEditorFallbackNotice choice={choice} />
      <ExtensionEditorSwitcher choice={choice} />
      <output data-testid="selected">{choice.selected}</output>
      <button type="button" onClick={() => choice.reportFailure(EXT.id, "blank")}>simulate load failure</button>
    </MemoryRouter>
  )
}

const openMenu = async () => userEvent.click(screen.getByTestId("edit-with-trigger"))

describe("Native Aquilla editor default, with optional custom extension editors", () => {
  beforeEach(() => localStorage.clear())

  it("opens the native editor by default; one menu lists the native editor first, then installed custom editors", async () => {
    render(<Harness />)
    expect(screen.getByTestId("selected")).toHaveTextContent("standard")
    expect(screen.getByRole("button", { name: "Edit with: Aquilla editor" })).toBeInTheDocument()
    await openMenu()
    const items = screen.getAllByRole("menuitemradio")
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Aquilla editor"),
      expect.stringContaining("Focus Editor"),
    ])
    expect(items[0]).toHaveAttribute("aria-checked", "true")
    expect(items[0]).toHaveTextContent("Your default")
  })

  it("lets any user opt into a custom editor per file or project-wide, then switch back to the native editor", async () => {
    const { unmount } = render(<Harness />)
    await openMenu()
    await userEvent.click(screen.getAllByRole("menuitemradio")[1])
    expect(screen.getByTestId("selected")).toHaveTextContent(EXT.id)
    expect(JSON.parse(localStorage.getItem(editorChoiceKey("carol", "p1")) ?? "{}")).toEqual({ project: null, files: { f1: EXT.id } })

    // Every file of the project: the explicit menu action.
    await openMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: /Set as default for this project/ }))
    expect(JSON.parse(localStorage.getItem(editorChoiceKey("carol", "p1")) ?? "{}")).toEqual({ project: EXT.id, files: {} })
    unmount()

    // Reloading on another file keeps the project-wide pick, and picking native switches back.
    render(<Harness fileId="f2" />)
    expect(screen.getByTestId("selected")).toHaveTextContent(EXT.id)
    await openMenu()
    expect(screen.getAllByRole("menuitemradio")[1]).toHaveTextContent("Your default")
    await userEvent.click(screen.getAllByRole("menuitemradio")[0])
    expect(screen.getByTestId("selected")).toHaveTextContent("standard")
  })

  // AQU-2260 (Sam, Oct 29): why it failed opens on a click of the notice,
  // never on a hover title.
  it("gives the failure's reason on click of the fallback notice", async () => {
    localStorage.setItem(editorChoiceKey("carol", "p1"), JSON.stringify({ project: EXT.id, files: {} }))
    render(<Harness />)
    act(() => screen.getByRole("button", { name: "simulate load failure" }).click())
    const notice = screen.getByTestId("extension-editor-fallback")
    expect(notice.querySelector("[title]")).toBeNull()
    await expectClickNote(screen.getByRole("button", { name: /couldn't load/ }), "blank")
  })

  it("falls back to the native editor when a chosen custom editor fails to load, and says so", async () => {
    localStorage.setItem(editorChoiceKey("carol", "p1"), JSON.stringify({ project: EXT.id, files: {} }))
    render(<Harness />)
    expect(screen.getByTestId("selected")).toHaveTextContent(EXT.id)
    act(() => screen.getByRole("button", { name: "simulate load failure" }).click())
    expect(screen.getByTestId("selected")).toHaveTextContent("standard")
    expect(screen.getByTestId("extension-editor-fallback")).toHaveTextContent(
      "Focus Editor couldn't load, so the original Aquilla editor is open.",
    )
    // Not persisted as native: Retry tries the chosen extension again.
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(screen.getByTestId("selected")).toHaveTextContent(EXT.id)
  })
})
