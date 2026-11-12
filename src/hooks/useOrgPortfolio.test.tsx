// AQU-1913 — the org overview and Projects page keep their percentages fresh
// when a numbers-affecting setting changes somewhere else (another person,
// another tab, an agent): they re-read on return to the tab and when the
// org's settings version moves.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useOrgPortfolio } from "./useOrgPortfolio"
import { resetWindowFocusRevalidateForTests } from "@/lib/sync/window-focus-revalidate"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna" }, loading: false }),
}))
vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({
    accessibleProjects: [],
    accessibleProjectsLoading: false,
    refreshAccessibleProjects: vi.fn(),
  }),
}))

const getOrgPortfolioSummary = vi.fn()
vi.mock("@/lib/frontier/portfolio", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/frontier/portfolio")>()),
  getOrgPortfolioSummary: (...a: unknown[]) => getOrgPortfolioSummary(...a),
}))

beforeEach(() => {
  resetWindowFocusRevalidateForTests()
  getOrgPortfolioSummary.mockReset()
  getOrgPortfolioSummary.mockResolvedValue({ projects: [], activeLanguageCount: 0 })
})

async function renderPortfolio(initial: { orgId: number | null; orgSettingsVersion: number | null }) {
  const view = renderHook(
    ({ orgId, orgSettingsVersion }: { orgId: number | null; orgSettingsVersion: number | null }) =>
      useOrgPortfolio(orgId, "Org", { orgSettingsVersion }),
    { initialProps: initial },
  )
  await waitFor(() => expect(view.result.current.isLoading).toBe(false))
  return view
}

describe("useOrgPortfolio — re-reads when a setting may have moved (AQU-1913)", () => {
  it("re-reads when the tab comes back", async () => {
    await renderPortfolio({ orgId: 7, orgSettingsVersion: 3 })
    expect(getOrgPortfolioSummary).toHaveBeenCalledTimes(1)

    act(() => { window.dispatchEvent(new Event("focus")) })

    await waitFor(() => expect(getOrgPortfolioSummary).toHaveBeenCalledTimes(2))
  })

  it("re-reads when the org's settings version moves", async () => {
    const view = await renderPortfolio({ orgId: 7, orgSettingsVersion: 3 })
    expect(getOrgPortfolioSummary).toHaveBeenCalledTimes(1)

    view.rerender({ orgId: 7, orgSettingsVersion: 4 })

    await waitFor(() => expect(getOrgPortfolioSummary).toHaveBeenCalledTimes(2))
  })

  it("does not re-read for the first version it sees — the numbers were read against it", async () => {
    const view = await renderPortfolio({ orgId: 7, orgSettingsVersion: null })
    view.rerender({ orgId: 7, orgSettingsVersion: 3 })
    await new Promise((r) => setTimeout(r, 50))
    expect(getOrgPortfolioSummary).toHaveBeenCalledTimes(1)
  })
})
