import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolSummary } from "@/lib/tools/tools-api"
import { editorChoiceKey } from "@/lib/tools/editor-choice"

/**
 * Daniel, 2026-10-12: the Smart Extension editor is the default, and ANY user
 * can switch back to the original "Aquilla editor" in one click — a local,
 * remembered choice no role or extension permission can block — and the
 * original editor opens by itself when the extension fails to load.
 */

const EXT: ToolSummary = {
  id: "fp-editor",
  name: "Aquilla editor (Smart Extension)",
  firstParty: "default-editor",
  manifest: { name: "Aquilla editor (Smart Extension)", description: "", scopes: ["read:cells"], mounts: ["page", "editor"], apiRev: 5, sdk: 1 },
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
    <div>
      <ExtensionEditorFallbackNotice choice={choice} />
      <ExtensionEditorSwitcher choice={choice} />
      <output data-testid="selected">{choice.selected}</output>
      <button type="button" onClick={() => choice.reportFailure(EXT.id, "blank")}>simulate load failure</button>
    </div>
  )
}

describe("Smart Extension editor default, with the original one click away", () => {
  beforeEach(() => localStorage.clear())

  it("opens the extension by default and labels it (default)", () => {
    render(<Harness />)
    expect(screen.getByTestId("selected")).toHaveTextContent(EXT.id)
    const picker = screen.getByRole("combobox", { name: "Edit with" })
    expect(picker).toHaveDisplayValue("Aquilla editor (Smart Extension) (default)")
    expect(screen.getByRole("option", { name: "Aquilla editor" })).toBeInTheDocument()
  })

  it("lets a commenter-level user (no write role, no extension grant) switch back, remembered for the project", async () => {
    // Nothing here reads the role or the grants: the choice is the user's own.
    const { unmount } = render(<Harness />)
    await userEvent.click(screen.getByRole("button", { name: "Use the original Aquilla editor" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("standard")
    expect(screen.queryByRole("button", { name: "Use the original Aquilla editor" })).toBeNull()
    expect(JSON.parse(localStorage.getItem(editorChoiceKey("carol", "p1")) ?? "{}")).toEqual({ project: "standard", files: {} })
    unmount()
    // A reload (fresh mount) and another file keep it.
    render(<Harness fileId="f2" />)
    expect(screen.getByTestId("selected")).toHaveTextContent("standard")
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
