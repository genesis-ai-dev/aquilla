// AQU-2306: the "N projects are stricter than this" line under the org's
// "Who can import files" floor — the disclosure the roster rows already carry
// (RosterProgressSection.test.tsx), on the row AQU-2305 made overridable.
// Stricter-only, so there is no reset link; the names link to the Import card,
// where a project's own value is set.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { ImportPermissionsSection } from "./ImportPermissionsSection"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi" }, loading: false }),
}))

const fetchCounts = vi.fn()
vi.mock("@/lib/sync/org-settings", async (importActual) => ({
  ...await importActual<typeof import("@/lib/sync/org-settings")>(),
  fetchVisibilityOverrideCounts: (...args: unknown[]) => fetchCounts(...args),
}))

function orgSettings(over: Partial<UseOrgSettings> = {}): UseOrgSettings {
  return {
    importMinRole: 500,
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    hasFetched: true,
    ...over,
  } as unknown as UseOrgSettings
}

beforeEach(() => {
  fetchCounts.mockReset()
})

describe("ImportPermissionsSection stricter-project line (AQU-2306)", () => {
  it("says how many projects require more than the org, with no reset link", async () => {
    fetchCounts.mockResolvedValue({ importMinRole: 1 })
    render(<ImportPermissionsSection orgSettings={orgSettings()} canEdit orgId={7} />)

    const row = await screen.findByTestId("override-status")
    expect(row.textContent).toBe("1 project is stricter than this")
    // No names came back, so the count stays plain text — and either way there
    // is no Reset: putting a stricter project back is that project's call.
    expect(within(row).queryByRole("button")).toBeNull()
    expect(fetchCounts).toHaveBeenCalledWith("jwt", 7)
  })

  it("shows the zero state when every project follows the org", async () => {
    fetchCounts.mockResolvedValue({ importMinRole: 0 })
    render(<ImportPermissionsSection orgSettings={orgSettings()} canEdit orgId={7} />)

    const row = await screen.findByTestId("override-status")
    expect(row.textContent).toBe("All projects follow this default.")
    expect(within(row).queryByRole("button")).toBeNull()
  })

  it("says nothing until the count is known, rather than claiming all projects follow", () => {
    fetchCounts.mockReturnValue(new Promise(() => {}))
    render(<ImportPermissionsSection orgSettings={orgSettings()} canEdit orgId={7} />)
    expect(screen.queryByTestId("override-status")).toBeNull()
    expect(screen.getByTestId("override-status-loading")).toBeTruthy()
  })

  it("asks again when the org's floor moves, since that alone changes who is stricter", async () => {
    fetchCounts.mockResolvedValue({ importMinRole: 1 })
    const { rerender } = render(<ImportPermissionsSection orgSettings={orgSettings()} canEdit orgId={7} />)
    await waitFor(() => expect(fetchCounts).toHaveBeenCalledTimes(1))

    fetchCounts.mockResolvedValue({ importMinRole: 0 })
    rerender(<ImportPermissionsSection orgSettings={orgSettings({ importMinRole: 600 })} canEdit orgId={7} />)
    await waitFor(() => expect(fetchCounts).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTestId("override-status").textContent).toBe("All projects follow this default."),
    )
  })

  it("the count opens the stricter projects, each linking to the Import card that sets its value", async () => {
    fetchCounts.mockResolvedValue({
      importMinRole: 3,
      overrideProjects: {
        importMinRole: { total: 3, projects: [{ id: "p-gen", name: "Genesis" }, { id: "p-exo", name: "Exodus" }] },
      },
    })
    render(<MemoryRouter><ImportPermissionsSection orgSettings={orgSettings()} canEdit orgId={7} /></MemoryRouter>)

    const toggle = await screen.findByRole("button", { name: "3 projects are stricter than this" })
    await userEvent.click(toggle)
    const row = screen.getByTestId("override-status")
    expect(within(row).getByRole("link", { name: "Genesis" }))
      .toHaveAttribute("href", "/project/p-gen/settings/general?focus=import")
    expect(within(row).getByRole("link", { name: "Exodus" }))
      .toHaveAttribute("href", "/project/p-exo/settings/general?focus=import")
    // One of the three is not this person's to see: counted, not named.
    expect(within(row).getAllByRole("listitem").at(-1)?.textContent).toBe("and 1 more")
  })

  it("shows no line at all without an org, where there are no projects to compare", () => {
    fetchCounts.mockResolvedValue({ importMinRole: 0 })
    render(<ImportPermissionsSection orgSettings={orgSettings()} canEdit />)
    expect(screen.queryByTestId("override-status")).toBeNull()
    expect(screen.queryByTestId("override-status-loading")).toBeNull()
    expect(fetchCounts).not.toHaveBeenCalled()
  })
})
