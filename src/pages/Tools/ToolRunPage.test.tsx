// AQU-2260 (Sam, Oct 29): the marks beside an extension's name say what they
// stand for on a click, never on hover: First party, "Built from", and the
// extension's own description under where it lives.
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import type { ToolDetail } from "@/lib/tools/tools-api"
import { ToolRunPage } from "./ToolRunPage"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
vi.mock("@/hooks/useProject", () => ({ useProject: () => ({ project: { id: "p1", name: "P" }, roleLevel: 700 }) }))
vi.mock("@/components/tools/useEditTool", () => ({ useEditTool: () => ({ run: vi.fn(), busy: false, error: null }) }))
vi.mock("@/components/tools/ToolFrame", () => ({ ToolFrame: () => null }))
vi.mock("@/components/tools/ToolActivityPanel", () => ({ ToolActivityPanel: () => null }))
vi.mock("@/components/tools/builder/VersionList", () => ({ VersionList: () => null }))
vi.mock("@/components/tools/builder/ChangeWithAi", () => ({ ChangeWithAi: () => null }))
vi.mock("@/components/tools/ExtensionDialogs", () => ({ CopyList: () => null, PermissionsList: () => null }))

const TOOL = {
  id: "t1", projectId: "p1", name: "Glossary", description: "Shows each verse's key terms", currentVersion: 3,
  upstreamToolId: null, createdBy: 1, createdAt: "x", updatedAt: "x", codeHash: "h", apiRev: 7,
  manifest: { name: "Glossary", description: "", scopes: [], mounts: ["panel"], apiRev: 7 },
  origin: "built", grantedScopes: [], firstParty: null,
}
let tool: Record<string, unknown> = TOOL
vi.mock("@/lib/tools/tools-api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/tools/tools-api")>()),
  getTool: vi.fn(async () => tool as unknown as ToolDetail),
  listToolVersions: vi.fn(async () => [{ version: 1, origin: "builder", buildMeta: { request: "a glossary panel" } }]),
  setToolGrant: vi.fn(async () => []),
}))

function renderPage() {
  return renderWithTooltips(
    <MemoryRouter initialEntries={["/project/p1/extensions/t1"]}>
      <Routes><Route path="/project/:id/extensions/:toolId" element={<ToolRunPage />} /></Routes>
    </MemoryRouter>,
  )
}

describe("ToolRunPage header marks", () => {
  it("says what it was built from, on click", async () => {
    tool = TOOL
    renderPage()
    await screen.findByRole("heading", { name: "Glossary" })
    await expectClickNote(await screen.findByTestId("built-from"), "Built from: “a glossary panel”")
  })

  it("gives the description on a click of where it lives, not as a hover title", async () => {
    tool = TOOL
    renderPage()
    await screen.findByRole("heading", { name: "Glossary" })
    expect(document.querySelector('[title="Shows each verse\'s key terms"]')).toBeNull()
    await expectClickNote(screen.getByRole("button", { name: "Side panel" }), "Shows each verse's key terms")
  })

  it("says what First party means, on click", async () => {
    tool = { ...TOOL, firstParty: "default-editor" }
    renderPage()
    await screen.findByRole("heading", { name: "Glossary" })
    await expectClickNote(screen.getByTestId("first-party-badge"), "First party · built in")
  })
})
