import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolSummary } from "@/lib/tools/tools-api"
import { editorChoiceKey } from "@/lib/tools/editor-choice"
import { expectClickNote } from "@/test-utils/tooltip"

/**
 * Daniel, 2026-10-12 / 10-14: the Smart Extension editor is the default; ANY
 * user switches back to the original "Aquilla editor" by picking it in the one
 * "Edit with" menu (this file), or makes it their default for the project
 * from the same menu (every file) — local, remembered choices no role or
 * extension permission can block. The original editor opens by itself when
 * the extension fails to load.
 */

const EXT: ToolSummary = {
  id: "fp-editor",
  name: "Aquilla editor (Smart Extension)",
  firstParty: "default-editor",
  manifest: { name: "Aquilla editor (Smart Extension)", description: "The Aquilla editor, as a Smart Extension", scopes: ["read:cells"], mounts: ["page", "editor"], apiRev: 5, sdk: 1 },
} as unknown as ToolSummary

const ctx = {
  projectId: "p1",
  tools: [EXT],
  defaultEditorId: EXT.id,
  defaultEditorEnabled: true,
  toolsReady: true,
  session: { jwt: "j", username: "carol" },
  autoGranted: [],
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

describe("Smart Extension editor default, with the original one pick away", () => {
  beforeEach(() => localStorage.clear())

  it("opens the extension by default; one menu lists the native editor first, then the extension, with the default marked", async () => {
    render(<Harness />)
    expect(screen.getByTestId("selected")).toHaveTextContent(EXT.id)
    expect(screen.getByRole("button", { name: "Edit with: Aquilla editor (Smart Extension)" })).toBeInTheDocument()
    await openMenu()
    const items = screen.getAllByRole("menuitemradio")
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Aquilla editor"),
      expect.stringContaining("Aquilla editor (Smart Extension)"),
    ])
    expect(items[1]).toHaveAttribute("aria-checked", "true")
    expect(items[1]).toHaveTextContent("Your default")
    // No separate switch-back button, checkbox or build button any more.
    expect(screen.queryByRole("button", { name: "Use the original Aquilla editor" })).toBeNull()
    expect(screen.queryByRole("checkbox", { name: "Use for every file in this project" })).toBeNull()
  })

  it("lets a commenter-level user (no write role, no extension grant) pick the original for a file, then make it the project default", async () => {
    // Nothing here reads the role or the grants: the choice is the user's own.
    const { unmount } = render(<Harness />)
    await openMenu()
    await userEvent.click(screen.getAllByRole("menuitemradio")[0])
    expect(screen.getByTestId("selected")).toHaveTextContent("standard")
    expect(JSON.parse(localStorage.getItem(editorChoiceKey("carol", "p1")) ?? "{}")).toEqual({ project: null, files: { f1: "standard" } })

    // Every file of the project: the explicit menu action.
    await openMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: /Set as default for this project/ }))
    expect(JSON.parse(localStorage.getItem(editorChoiceKey("carol", "p1")) ?? "{}")).toEqual({ project: "standard", files: {} })
    unmount()
    // A reload (fresh mount) and another file keep it.
    render(<Harness fileId="f2" />)
    expect(screen.getByTestId("selected")).toHaveTextContent("standard")
    await openMenu()
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveTextContent("Your default")
  })

  // AQU-2260 (Sam, Oct 29): why it failed opens on a click of the notice,
  // never on a hover title.
  it("gives the failure's reason on click of the fallback notice", async () => {
    render(<Harness />)
    act(() => screen.getByRole("button", { name: "simulate load failure" }).click())
    const notice = screen.getByTestId("extension-editor-fallback")
    expect(notice.querySelector("[title]")).toBeNull()
    await expectClickNote(screen.getByRole("button", { name: /couldn't load/ }), "blank")
  })

  it("falls back to the original editor when the extension fails to load, and says so", async () => {
    render(<Harness />)
    act(() => screen.getByRole("button", { name: "simulate load failure" }).click())
    expect(screen.getByTestId("selected")).toHaveTextContent("standard")
    expect(screen.getByTestId("extension-editor-fallback")).toHaveTextContent(
      "Aquilla editor (Smart Extension) couldn't load, so the original Aquilla editor is open.",
    )
    // Not persisted: the user's choice is untouched, and Retry tries again.
    expect(localStorage.getItem(editorChoiceKey("carol", "p1"))).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(screen.getByTestId("selected")).toHaveTextContent(EXT.id)
  })
})
