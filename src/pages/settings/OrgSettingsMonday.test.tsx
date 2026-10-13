import { beforeEach, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgSettingsMonday } from "./OrgSettingsMonday"
import { fetchMondayConnection, fetchMondayOrgLinks, startMondayConnect } from "@/lib/monday/api"
import { announceMondayOAuthOutcome } from "@/lib/monday/oauth-return"

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
  fetchMondayOrgLinks: vi.fn(),
}))
// The setup steps are their own component, tested on their own; here only
// whether they open in place, for which project.
vi.mock("@/components/ProjectSettings/MondaySetupWizard", () => ({
  MondaySetupWizard: ({ projectId }: { projectId: string }) => <div data-testid="setup-wizard">{projectId}</div>,
}))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchMondayOrgLinks).mockResolvedValue([])
})
it("lists the organization's own projects without another authorization", async () => {
  vi.mocked(fetchMondayConnection).mockResolvedValue({ connected: true })
  render(<MemoryRouter><OrgSettingsMonday /></MemoryRouter>)
  const link = await screen.findByRole("link", { name: "Manage in project settings" })
  expect(link).toHaveAttribute("href", "/project/ours/settings/integrations#section-monday")
  expect(screen.queryByText("Other organization")).toBeNull()
  expect(screen.queryByRole("button", { name: /^connect monday/i })).toBeNull()
})

it("sets up an unlinked project right here, without leaving org settings", async () => {
  vi.mocked(fetchMondayConnection).mockResolvedValue({ connected: true })
  render(<MemoryRouter><OrgSettingsMonday /></MemoryRouter>)
  expect(await screen.findByText("Not linked yet")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Set up" }))
  expect(screen.getByTestId("setup-wizard").textContent).toBe("ours")
})

it("says which board a linked project uses, and when its Sync is paused", async () => {
  vi.mocked(fetchMondayConnection).mockResolvedValue({ connected: true })
  vi.mocked(fetchMondayOrgLinks).mockResolvedValue([
    {
      projectId: "ours", boardId: "b1", boardName: "Translation Tracker", boardUrl: null,
      enabled: false, structureStale: false, lastPushedAt: null, lastPushStatus: null,
    },
  ])
  render(<MemoryRouter><OrgSettingsMonday /></MemoryRouter>)
  expect(await screen.findByText(/linked to translation tracker/i)).toBeTruthy()
  expect(screen.getByText("Sync paused")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Set up" })).toBeNull()
})

it("shows a failed connect's reason in plain words when Monday sends the user back", async () => {
  vi.mocked(fetchMondayConnection).mockResolvedValue({ connected: false })
  render(<MemoryRouter initialEntries={["/orgs/7/settings/monday?monday=error&reason=expired"]}><OrgSettingsMonday /></MemoryRouter>)
  const notice = await screen.findByRole("alert")
  expect(notice.textContent).toMatch(/within 10 minutes/)
  expect(notice.textContent).not.toMatch(/expired\)/)
})

it("stops waiting and shows the failure when the Monday tab reports one", async () => {
  vi.mocked(fetchMondayConnection).mockResolvedValue({ connected: false })
  vi.mocked(startMondayConnect).mockResolvedValue({ url: "https://auth.monday.com/x" })
  const popup = { closed: false, location: { href: "" }, close: vi.fn() }
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window)
  render(<MemoryRouter><OrgSettingsMonday /></MemoryRouter>)

  fireEvent.click(await screen.findByRole("button", { name: /connect monday/i }))
  fireEvent.click(await screen.findByRole("button", { name: /yes, i'm a monday admin/i }))
  expect(await screen.findByText(/waiting for the monday\.com tab/i)).toBeTruthy()

  announceMondayOAuthOutcome({ ok: false, reason: "cancelled", orgId: 7 })

  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/cancelled in Monday\.com/))
  expect(screen.queryByText(/waiting for the monday\.com tab/i)).toBeNull()
})

it("links to the connected Monday account once, from the Open Monday.com button", async () => {
  vi.mocked(fetchMondayConnection).mockResolvedValue({
    connected: true, account: { id: "1", slug: "acme-team", userName: "Sam" },
  } as Awaited<ReturnType<typeof fetchMondayConnection>>)
  render(<MemoryRouter><OrgSettingsMonday /></MemoryRouter>)
  const open = await screen.findByRole("link", { name: "Open Monday.com" })
  expect(open).toHaveAttribute("href", "https://acme-team.monday.com")
  expect(open).toHaveAttribute("target", "_blank")
  expect(screen.getByText("acme-team")).toBeTruthy()
  expect(screen.queryByRole("link", { name: "acme-team" })).toBeNull()
})
