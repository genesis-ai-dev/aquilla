// MondayIntegrationSection — light render tests of the three top-level states
// (org-not-connected, unlinked-with-boards, linked-with-mapping). The api lib
// is mocked wholesale; flows (analyze/apply) are covered by the api tests +
// server tests, not re-driven here — this guards the state routing and the
// role gating that decide WHAT a member sees.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { MondayIntegrationSection } from "./MondayIntegrationSection"
import type { MondayBoardLink } from "@/lib/monday/api"
import * as api from "@/lib/monday/api"

vi.mock("@/lib/monday/api", () => ({
  fetchMondayConnection: vi.fn(),
  fetchMondayLink: vi.fn(),
  fetchMondayBoards: vi.fn(),
  fetchMondayBoardStructure: vi.fn(),
  putMondayLink: vi.fn(),
  patchMondayLink: vi.fn(),
  deleteMondayLink: vi.fn(),
  analyzeMondayMapping: vi.fn(),
  syncMondayNow: vi.fn(),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester" }, loading: false }),
}))

const mocked = vi.mocked(api)

function makeLink(overrides: Partial<MondayBoardLink> = {}): MondayBoardLink {
  return {
    id: "l1",
    boardId: "b1",
    boardName: "Translation Tracker",
    enabled: true,
    config: {
      version: 1,
      itemGranularity: "project",
      columns: [{ columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" }],
    },
    structureStale: false,
    lastPushedAt: "2026-07-20T10:00:00Z",
    lastPushStatus: "ok",
    lastPushError: null,
    orgConnected: true,
    ...overrides,
  }
}

function renderSection(props: Partial<Parameters<typeof MondayIntegrationSection>[0]> = {}) {
  return render(
    <MemoryRouter>
      <MondayIntegrationSection projectId="p1" orgId={7} roleLevel={600} {...props} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.fetchMondayBoards.mockResolvedValue([])
  mocked.fetchMondayBoardStructure.mockResolvedValue({ columns: [], groups: [] })
})

describe("MondayIntegrationSection", () => {
  it("org not connected: explains and links to org settings", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: false })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: false })

    renderSection()

    await waitFor(() =>
      expect(screen.getByText(/hasn't connected monday\.com yet/i)).toBeTruthy(),
    )
    const orgLink = screen.getByRole("link", { name: /organization settings/i })
    expect(orgLink.getAttribute("href")).toBe("/settings/monday")
    // No board picker in this state.
    expect(screen.queryByLabelText(/monday board/i)).toBeNull()
  })

  it("unlinked with boards: shows the board picker and AI configure affordance", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: false })
    mocked.fetchMondayConnection.mockResolvedValue({
      connected: true,
      account: { id: "1", slug: "acme", userName: "Ann" },
    })
    mocked.fetchMondayBoards.mockResolvedValue([
      { id: "b1", name: "Translation Tracker", workspace: { id: "w1", name: "Main" } },
    ])

    renderSection()

    await waitFor(() => expect(screen.getByLabelText(/monday board/i)).toBeTruthy())
    expect(mocked.fetchMondayBoards).toHaveBeenCalledWith("tok", 7)
    expect(screen.getByText(/use ai to configure/i)).toBeTruthy()
  })

  it("unlinked, below maintainer: read-only summary, no picker, no boards fetch", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: false })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: true })

    renderSection({ roleLevel: 400 })

    await waitFor(() =>
      expect(screen.getByText(/no monday board is linked/i)).toBeTruthy(),
    )
    expect(screen.queryByLabelText(/monday board/i)).toBeNull()
    expect(mocked.fetchMondayBoards).not.toHaveBeenCalled()
  })

  it("linked: shows board name, enabled switch, last push status and mapping", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink() })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: true })
    mocked.fetchMondayBoardStructure.mockResolvedValue({
      columns: [{ id: "numbers_1", title: "Progress", type: "numbers" }],
      groups: [],
    })

    renderSection()

    await waitFor(() => expect(screen.getByText("Translation Tracker")).toBeTruthy())
    expect(screen.getByRole("switch")).toBeTruthy()
    expect(screen.getByRole("button", { name: /sync now/i })).toBeTruthy()
    expect(screen.getByText(/last push .*ok/i)).toBeTruthy()
    // Mapping editor is present for maintainers, seeded from config.
    expect(screen.getByTestId("monday-mapping-editor")).toBeTruthy()
    expect(screen.getByLabelText(/reconfigure with ai/i)).toBeTruthy()
  })

  it("linked with stale structure: shows the amber review banner", async () => {
    mocked.fetchMondayLink.mockResolvedValue({
      linked: true,
      link: makeLink({ structureStale: true }),
    })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: true })

    renderSection()

    await waitFor(() =>
      expect(screen.getByText(/board structure changed/i)).toBeTruthy(),
    )
  })

  it("linked, below maintainer: read-only mapping table, no editor or sync controls", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink() })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: true })

    renderSection({ roleLevel: 400 })

    await waitFor(() => expect(screen.getByText("Translation Tracker")).toBeTruthy())
    expect(screen.queryByTestId("monday-mapping-editor")).toBeNull()
    expect(screen.getByTestId("monday-mapping-preview")).toBeTruthy()
    const syncBtn = screen.getByRole("button", { name: /sync now/i }) as HTMLButtonElement
    expect(syncBtn.disabled).toBe(true)
    expect(screen.queryByLabelText(/reconfigure with ai/i)).toBeNull()
  })
})
