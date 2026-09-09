import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { MemoryRouter, useLocation } from "react-router-dom"
import { ProjectMondayCard } from "./ProjectMondayCard"
import { fetchMondayLink, fetchMondayBoardStructure, type MondayBoardLink } from "@/lib/monday/api"

vi.mock("@/lib/monday/api", () => ({ fetchMondayLink: vi.fn(), fetchMondayBoardStructure: vi.fn() }))
const linked: MondayBoardLink = {
  id: "link-1", boardId: "123", boardName: "Translation tracker",
  boardUrl: "https://actual-account.monday.com/boards/123",
  enabled: true, orgConnected: true, structureStale: false,
  lastPushedAt: null, lastPushStatus: null, lastPushError: null,
  config: { version: 1, itemGranularity: "file", columns: [] },
}
function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{JSON.stringify({ path: location.pathname, state: location.state })}</output>
}
function view(roleLevel = 600, jwt: string | null = "token") {
  return render(<MemoryRouter initialEntries={["/projects/p1"]}>
    <ProjectMondayCard projectId="p1" jwt={jwt} roleLevel={roleLevel} />
    <LocationProbe />
  </MemoryRouter>)
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchMondayLink).mockResolvedValue({ linked: false, orgConnected: false })
})
it("hides the card for disconnected organizations and signed-out users", async () => {
  const first = await act(async () => view())
  expect(screen.queryByLabelText("Monday.com")).toBeNull()
  first.unmount()
  vi.mocked(fetchMondayLink).mockClear()
  await act(async () => view(600, null))
  expect(fetchMondayLink).not.toHaveBeenCalled()
  expect(screen.queryByLabelText("Monday.com")).toBeNull()
})
it("offers board setup for a connected project and preserves overview modal navigation", async () => {
  vi.mocked(fetchMondayLink).mockResolvedValue({ linked: false, orgConnected: true, orgId: 7 })
  view()
  const link = await screen.findByRole("link", { name: "Link a board" })
  expect(fetchMondayLink).toHaveBeenCalledWith("token", "p1")
  expect(link).toHaveAttribute("href", "/project/p1/settings/integrations")
  fireEvent.click(link)
  const location = JSON.parse(screen.getByTestId("location").textContent!)
  expect(location.state.backgroundLocation.pathname).toBe("/projects/p1")
  expect(location.state.projectSettingsModalDepth).toBe(1)
})
it("opens the authoritative saved board URL and offers configuration", async () => {
  vi.mocked(fetchMondayLink).mockResolvedValue({ linked: true, link: linked })
  view()
  expect(await screen.findByRole("link", { name: "Open board in Monday" })).toHaveAttribute("href", linked.boardUrl)
  expect(screen.getByRole("link", { name: "Configure link" })).toHaveAttribute("href", "/project/p1/settings/integrations")
  expect(fetchMondayBoardStructure).not.toHaveBeenCalled()
})
it("members can open linked boards but cannot configure or create links", async () => {
  vi.mocked(fetchMondayLink).mockResolvedValue({ linked: true, link: linked })
  const first = view(400)
  expect(await screen.findByRole("link", { name: "Open board in Monday" })).toBeTruthy()
  expect(screen.queryByRole("link", { name: "Configure link" })).toBeNull()
  first.unmount()
  vi.mocked(fetchMondayLink).mockResolvedValue({ linked: false, orgConnected: true })
  view(400)
  expect(await screen.findByText("A project maintainer can link a board.")).toBeTruthy()
  expect(screen.queryByRole("link", { name: "Link a board" })).toBeNull()
})
it("resolves legacy links from the project's organization without guessing a URL", async () => {
  vi.mocked(fetchMondayLink).mockResolvedValue({ linked: true, orgId: 7, link: { ...linked, boardUrl: null } })
  vi.mocked(fetchMondayBoardStructure).mockResolvedValue({ url: linked.boardUrl, columns: [], groups: [] })
  view()
  expect(await screen.findByRole("link", { name: "Open board in Monday" })).toHaveAttribute("href", linked.boardUrl)
  expect(fetchMondayBoardStructure).toHaveBeenCalledWith("token", 7, "123")
})
it("keeps configuration available when a legacy board URL cannot be read", async () => {
  vi.mocked(fetchMondayLink).mockResolvedValue({ linked: true, orgId: 7, link: { ...linked, boardUrl: null } })
  vi.mocked(fetchMondayBoardStructure).mockRejectedValue(new Error("Forbidden"))
  view()
  expect(await screen.findByRole("link", { name: "Configure link" })).toBeTruthy()
  expect(screen.queryByRole("link", { name: "Open board in Monday" })).toBeNull()
  expect(screen.getByText(/find the board by name/i)).toBeTruthy()
})
it("refreshes after returning from Monday and hides a disconnected card", async () => {
  vi.mocked(fetchMondayLink).mockResolvedValue({ linked: true, link: linked })
  view()
  await screen.findByRole("link", { name: "Open board in Monday" })
  vi.mocked(fetchMondayLink).mockResolvedValue({ linked: false, orgConnected: false })
  fireEvent.focus(window)
  await waitFor(() => expect(screen.queryByLabelText("Monday.com")).toBeNull())
})
it("does not offer setup when connection status is unknown", async () => {
  vi.mocked(fetchMondayLink).mockRejectedValue(new Error("Unavailable"))
  await act(async () => view())
  expect(screen.queryByLabelText("Monday.com")).toBeNull()
})

it("refreshes the mounted card when the real link API saves and removes a board", async () => {
  const actualApi = await vi.importActual<typeof import("@/lib/monday/api")>("@/lib/monday/api")
  vi.mocked(fetchMondayLink).mockResolvedValue({ linked: false, orgConnected: true })
  view()
  await screen.findByRole("link", { name: "Link a board" })
  const fetchStub = vi.spyOn(globalThis, "fetch")
  try {
    fetchStub.mockResolvedValue(new Response(JSON.stringify({ link: linked }), { status: 200 }))
    vi.mocked(fetchMondayLink).mockResolvedValue({ linked: true, link: linked })
    await act(async () => {
      await actualApi.putMondayLink("token", "p1", { boardId: linked.boardId, config: linked.config })
    })
    expect(await screen.findByRole("link", { name: "Open board in Monday" })).toHaveAttribute("href", linked.boardUrl)
    const renamed = { ...linked, boardName: "Renamed tracker" }
    fetchStub.mockResolvedValue(new Response(JSON.stringify({ link: renamed }), { status: 200 }))
    vi.mocked(fetchMondayLink).mockResolvedValue({ linked: true, link: renamed })
    await act(async () => { await actualApi.patchMondayLink("token", "p1", { enabled: false }) })
    expect(await screen.findByText("Renamed tracker")).toBeTruthy()
    fetchStub.mockResolvedValue(new Response(null, { status: 204 }))
    vi.mocked(fetchMondayLink).mockResolvedValue({ linked: false, orgConnected: true })
    await act(async () => { await actualApi.deleteMondayLink("token", "p1") })
    expect(await screen.findByRole("link", { name: "Link a board" })).toBeTruthy()
  } finally {
    fetchStub.mockRestore()
  }
})
