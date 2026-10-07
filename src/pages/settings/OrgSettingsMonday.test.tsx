import { beforeEach, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgSettingsMonday } from "./OrgSettingsMonday"
import { fetchMondayConnection } from "@/lib/monday/api"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok" } }),
}))
vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({
    activeOrgId: 7, activeOrg: { role: { level: 700 } },
    accessibleProjectsLoading: false,
    accessibleProjects: [
      { id: "ours", name: "Our translation", orgId: 7, role: { level: 600 } },
      { id: "theirs", name: "Other organization", orgId: 8, role: { level: 700 } },
    ],
  }),
}))
vi.mock("./OrgSettingsDetailPage", () => ({
  OrgSettingsDetailPage: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/lib/monday/api", () => ({
  fetchMondayConnection: vi.fn(), startMondayConnect: vi.fn(), deleteMondayConnection: vi.fn(),
}))
beforeEach(() => vi.clearAllMocks())
it("hands a connected organization off to its own projects without another authorization", async () => {
  vi.mocked(fetchMondayConnection).mockResolvedValue({ connected: true })
  render(<MemoryRouter><OrgSettingsMonday /></MemoryRouter>)
  const link = await screen.findByRole("link", { name: "Set up or manage board" })
  expect(link).toHaveAttribute("href", "/project/ours/settings/integrations#section-monday")
  expect(screen.queryByText("Other organization")).toBeNull()
  expect(screen.queryByRole("button", { name: /^connect monday/i })).toBeNull()
})
