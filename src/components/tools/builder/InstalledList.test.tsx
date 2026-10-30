// AQU-2260 (Sam, Oct 29): the first-party mark is not a button, so it says
// nothing on hover; the row's own line already prints "First party · built in".
import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { renderWithTooltips } from "@/test-utils/tooltip"
import type { ToolSummary } from "@/lib/tools/tools-api"
import { InstalledList } from "./InstalledList"

const tool = {
  id: "t1", projectId: "p1", name: "Aquilla editor", description: "", currentVersion: 1, upstreamToolId: null,
  createdBy: 1, createdAt: "x", updatedAt: "x", codeHash: "h", apiRev: 7,
  manifest: { name: "Aquilla editor", description: "", scopes: [], mounts: ["editor"], apiRev: 7 },
  origin: "built", grantedScopes: [], firstParty: "default-editor",
} as unknown as ToolSummary

describe("InstalledList first-party mark", () => {
  it("prints First party on the row and shows nothing on hover of the mark", async () => {
    renderWithTooltips(<MemoryRouter><InstalledList projectId="p1" tools={[tool]} menuFor={() => []} /></MemoryRouter>)
    const row = screen.getByTestId("installed-tool")
    expect(row).toHaveTextContent("First party · built in")
    await userEvent.setup().hover(screen.getByTestId("first-party-badge"))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})
