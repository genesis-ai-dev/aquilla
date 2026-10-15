// AQU-1771: the "N projects are stricter" line under the org's two visibility
// floors. A project may only make them stricter, so there is no reset link.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import { RosterProgressSection } from "./RosterProgressSection"
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
    rosterViewMinRole: 600,
    memberProgressViewMinRole: 600,
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    hasFetched: true,
    ...over,
  } as unknown as UseOrgSettings
}

beforeEach(() => {
  fetchCounts.mockReset()
})

describe("RosterProgressSection stricter-project line (AQU-1771)", () => {
  it("says how many projects are stricter under each setting, with no reset link", async () => {
    fetchCounts.mockResolvedValue({ rosterViewMinRole: 2, memberProgressViewMinRole: 0 })
    render(<RosterProgressSection orgSettings={orgSettings()} canEdit orgId={7} />)

    await waitFor(() => expect(screen.getAllByTestId("override-status")).toHaveLength(2))
    const [roster, progress] = screen.getAllByTestId("override-status")
    expect(roster.textContent).toBe("2 projects are stricter than this")
    expect(progress.textContent).toBe("All projects follow this default.")
    expect(within(roster).queryByRole("button")).toBeNull()
    expect(fetchCounts).toHaveBeenCalledWith("jwt", 7)
  })

  it("asks again when a floor changes, since that changes which projects are stricter", async () => {
    fetchCounts.mockResolvedValue({ rosterViewMinRole: 1, memberProgressViewMinRole: 1 })
    const { rerender } = render(<RosterProgressSection orgSettings={orgSettings()} canEdit orgId={7} />)
    await waitFor(() => expect(fetchCounts).toHaveBeenCalledTimes(1))

    fetchCounts.mockResolvedValue({ rosterViewMinRole: 0, memberProgressViewMinRole: 1 })
    rerender(<RosterProgressSection orgSettings={orgSettings({ rosterViewMinRole: 700 })} canEdit orgId={7} />)
    await waitFor(() => expect(fetchCounts).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getAllByTestId("override-status")[0].textContent).toBe("All projects follow this default."),
    )
  })

  it("says nothing until the count is known", () => {
    fetchCounts.mockReturnValue(new Promise(() => {}))
    render(<RosterProgressSection orgSettings={orgSettings()} canEdit orgId={7} />)
    expect(screen.queryByTestId("override-status")).toBeNull()
    expect(screen.getAllByTestId("override-status-loading")).toHaveLength(2)
  })
})
