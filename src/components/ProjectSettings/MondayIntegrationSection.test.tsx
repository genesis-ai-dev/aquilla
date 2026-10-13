// MondayIntegrationSection — light render tests of the three top-level states
// (org-not-connected, unlinked-with-boards, linked-with-mapping). The api lib
// is mocked wholesale; flows (analyze/apply) are covered by the api tests +
// server tests, not re-driven here — this guards the state routing and the
// role gating that decide WHAT a member sees.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { MondayIntegrationSection } from "./MondayIntegrationSection"
import type { MondayBoardLink } from "@/lib/monday/api"
import * as api from "@/lib/monday/api"

vi.mock("@/lib/monday/api", () => ({
  fetchMondayConnection: vi.fn(),
  fetchMondayLink: vi.fn(),
  fetchMondayBoards: vi.fn(),
  fetchMondayBoardStructure: vi.fn(),
  fetchMondayBoardChanges: vi.fn(),
  dismissMondayBoardChanges: vi.fn(),
  putMondayLink: vi.fn(),
  patchMondayLink: vi.fn(),
  addMondayColumns: vi.fn(),
  deleteMondayLink: vi.fn(),
  analyzeMondayMapping: vi.fn(),
  syncMondayNow: vi.fn(),
  startMondayConnect: vi.fn(),
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
  // Unless a test says otherwise, the board-changes read fails and the page
  // falls back to the plain column list, leaving the link's own flag alone.
  mocked.fetchMondayBoardChanges.mockRejectedValue(new Error("not mocked"))
})

describe("MondayIntegrationSection", () => {
  it("org not connected, below maintainer: points at the ORG-SCOPED settings route", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: false })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: false })

    renderSection({ roleLevel: 400 })

    await waitFor(() =>
      expect(screen.getByText(/hasn't connected monday\.com yet/i)).toBeTruthy(),
    )
    const orgLink = screen.getByRole("link", { name: /organization settings/i })
    // Regression guard: the un-scoped "/settings/monday" has no route and sent
    // users (including everyone finishing OAuth) to the 404 page.
    expect(orgLink.getAttribute("href")).toBe("/orgs/7/settings/monday")
    expect(screen.queryByLabelText(/monday board/i)).toBeNull()
  })

  it("org not connected, maintainer: offers the AI wizard, which owns the connect step", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: false })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: false })

    renderSection()

    // The wizard drives OAuth itself, so a maintainer is never sent away to
    // org settings and back just to begin.
    await waitFor(() => expect(screen.getByTestId("monday-setup-with-ai")).toBeTruthy())
  })

  it("unlinked: AI setup is the primary affordance and costs no board listing", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: false })
    mocked.fetchMondayConnection.mockResolvedValue({
      connected: true,
      account: { id: "1", slug: "acme", userName: "Ann" },
    })
    mocked.fetchMondayBoards.mockResolvedValue([
      { id: "b1", name: "Translation Tracker", workspace: { id: "w1", name: "Main" } },
    ])

    renderSection()

    await waitFor(() => expect(screen.getByTestId("monday-setup-with-ai")).toBeTruthy())
    // The picker is behind the manual escape hatch now — and because the AI
    // picks the board server-side, the default path lists no boards at all.
    expect(screen.queryByLabelText(/monday board/i)).toBeNull()
    expect(mocked.fetchMondayBoards).not.toHaveBeenCalled()
  })

  it("unlinked: the manual escape hatch opens the same steps without the AI, starting with the board", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: false })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: true })
    mocked.fetchMondayBoards.mockResolvedValue([
      { id: "b1", name: "Translation Tracker", workspace: { id: "w1", name: "Main" } },
    ])

    renderSection()

    await waitFor(() => expect(screen.getByTestId("monday-setup-with-ai")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /set it up manually/i }))

    await waitFor(() => expect(screen.getByLabelText(/monday board/i)).toBeTruthy())
    expect(mocked.fetchMondayBoards).toHaveBeenCalledWith("tok", 7)
    expect(screen.getByText("Step 1 of 3")).toBeTruthy()
    expect(mocked.analyzeMondayMapping).not.toHaveBeenCalled()
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

  it("saving the mapping shows what the server dropped, and the stale banner clears once the board is re-read", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink({ structureStale: true }) })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: true })
    const dropped = 'column "ghost_col" not found on the board; dropped'
    mocked.patchMondayLink.mockResolvedValue({
      link: makeLink({ structureStale: false, config: { version: 1, itemGranularity: "project", columns: [] } }),
      warnings: [dropped],
    })

    renderSection()
    await waitFor(() => expect(screen.getByText(/board structure changed/i)).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: /remove mapping row/i }))
    fireEvent.click(screen.getByRole("button", { name: /save mapping/i }))

    await waitFor(() => expect(screen.getByText(dropped)).toBeTruthy())
    expect(screen.queryByText(/board structure changed/i)).toBeNull()
  })

  it("Sync now waits for the Sync switch: disabled while paused, with the reason on hover", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink({ enabled: false }) })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: true })

    renderSection()

    const syncBtn = (await screen.findByRole("button", { name: /sync now/i })) as HTMLButtonElement
    expect(syncBtn.disabled).toBe(true)
    // A disabled button gets no pointer events in a real browser, so the
    // tooltip must hang on a wrapper (see AppTooltip, AQU-959).
    expect(syncBtn.closest('[data-slot="tooltip-disabled-trigger"]')).not.toBeNull()
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

it("uses the project's connection status when organization metadata is unavailable", async () => {
  mocked.fetchMondayLink.mockResolvedValue({ linked: false, orgConnected: true } as api.MondayLinkStatus)
  mocked.fetchMondayConnection.mockRejectedValue(new Error("Organization membership required"))
  renderSection()
  fireEvent.click(await screen.findByTestId("monday-setup-with-ai"))
  expect(await screen.findByRole("button", { name: "Scan and propose" })).toBeTruthy()
  expect(mocked.startMondayConnect).not.toHaveBeenCalled()
})

it("keeps a failed status check distinct from a disconnected organization", async () => {
  mocked.fetchMondayLink.mockRejectedValue(new Error("Connection status unavailable"))
  mocked.fetchMondayConnection.mockResolvedValue({ connected: false })
  renderSection()
  expect(await screen.findByRole("button", { name: /retry/i })).toBeTruthy()
  expect(screen.queryByTestId("monday-setup-with-ai")).toBeNull()
})

it("refreshes organization authorization when returning from another tab", async () => {
  mocked.fetchMondayLink.mockResolvedValue({ linked: false, orgConnected: false })
  mocked.fetchMondayConnection.mockResolvedValue({ connected: false })
  renderSection()
  fireEvent.click(await screen.findByTestId("monday-setup-with-ai"))
  expect(screen.getByRole("button", { name: "Connect and scan" })).toBeTruthy()
  mocked.fetchMondayLink.mockResolvedValue({ linked: false, orgConnected: true })
  mocked.fetchMondayConnection.mockResolvedValue({ connected: true })
  fireEvent.focus(window)
  expect(await screen.findByRole("button", { name: "Scan and propose" })).toBeTruthy()
})

describe("Add columns (linked board)", () => {
  it("opens the column list and saves the new columns into the mapping", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink() })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: true })
    mocked.addMondayColumns.mockResolvedValue({
      created: [{ metric: "validated_pct", columnId: "v1", columnType: "numbers", title: "Validated %" }],
      reused: [],
      failed: [],
      structure: { columns: [{ id: "v1", title: "Validated %", type: "numbers" }], groups: [] },
    })
    mocked.patchMondayLink.mockResolvedValue({ link: makeLink(), warnings: [] })

    renderSection()
    fireEvent.click(await screen.findByTestId("monday-add-columns"))
    const dialog = await screen.findByTestId("monday-add-columns-dialog")
    // Only what the board already uses starts ticked (plus the locked Aquilla ID).
    expect(screen.getByRole("checkbox", { name: /^Completion %$/ }).getAttribute("aria-checked")).toBe("true")
    const box = screen.getByRole("checkbox", { name: /^Validated %$/ })
    expect(box.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(box)
    await waitFor(() => expect(box.getAttribute("aria-checked")).toBe("true"))
    fireEvent.click(screen.getByRole("button", { name: /^add 2 columns$/i }))

    await waitFor(() => expect(mocked.patchMondayLink).toHaveBeenCalled())
    expect(mocked.addMondayColumns.mock.calls[0][2]).toEqual({ boardId: "b1", metrics: ["validated_pct", "external_id"] })
    expect(mocked.patchMondayLink.mock.calls[0][2].config?.columns).toEqual([
      { columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" },
      { columnId: "v1", columnType: "numbers", metric: "validated_pct" },
    ])
    await waitFor(() => expect(dialog.isConnected).toBe(false))
  })

  it("below maintainer: no Add columns", async () => {
    mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink() })
    mocked.fetchMondayConnection.mockResolvedValue({ connected: true })
    renderSection({ roleLevel: 400 })
    await waitFor(() => expect(screen.getByText(/translation tracker/i)).toBeTruthy())
    expect(screen.queryByTestId("monday-add-columns")).toBeNull()
  })

  describe("new columns on the board (Board structure changed)", () => {
    const columns = [
      { id: "numbers_1", title: "Completion %", type: "numbers" },
      { id: "numeric_b", title: "Budget", type: "numbers" },
      { id: "formula_f", title: "Total", type: "formula" },
    ]
    const changes = (newIds: string[]) => ({
      structureStale: newIds.length > 0,
      newColumns: columns.filter((col) => newIds.includes(col.id)),
      structure: { columns, groups: [] },
    })

    it("names each new column; Map it adds its row to the mapping, ready to save", async () => {
      mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink({ structureStale: true }) })
      mocked.fetchMondayConnection.mockResolvedValue({ connected: true })
      mocked.fetchMondayBoardChanges.mockResolvedValue(changes(["numeric_b", "formula_f"]))
      mocked.patchMondayLink.mockResolvedValue({ link: makeLink(), warnings: [] })

      renderSection()
      const banner = await screen.findByTestId("monday-board-changes")
      await waitFor(() => expect(banner.textContent).toMatch(/budget/i))
      expect(banner.textContent).toMatch(/total/i)
      expect(banner.textContent).toMatch(/can't fill this kind of column/i)
      expect(screen.getAllByRole("button", { name: /map it/i })).toHaveLength(1)

      fireEvent.click(screen.getByRole("button", { name: /map it/i }))
      fireEvent.click(screen.getByRole("button", { name: /save mapping/i }))
      await waitFor(() => expect(mocked.patchMondayLink).toHaveBeenCalled())
      const sent = mocked.patchMondayLink.mock.calls[0]![2].config!.columns.map((col) => col.columnId)
      expect(sent).toEqual(["numbers_1", "numeric_b"])
    })

    it("Not needed stops asking, and the banner goes once nothing is left", async () => {
      mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink({ structureStale: true }) })
      mocked.fetchMondayConnection.mockResolvedValue({ connected: true })
      mocked.fetchMondayBoardChanges.mockResolvedValue(changes(["numeric_b"]))
      mocked.dismissMondayBoardChanges.mockResolvedValue(changes([]))

      renderSection()
      fireEvent.click(await screen.findByRole("button", { name: /not needed/i }))
      await waitFor(() => expect(screen.queryByTestId("monday-board-changes")).toBeNull())
      expect(mocked.dismissMondayBoardChanges).toHaveBeenCalledWith("tok", "p1", ["numeric_b"])
    })

    it("a new column that was deleted again clears the banner on its own", async () => {
      mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink({ structureStale: true }) })
      mocked.fetchMondayConnection.mockResolvedValue({ connected: true })
      mocked.fetchMondayBoardChanges.mockResolvedValue(changes([]))

      renderSection()
      await screen.findByText("Translation Tracker")
      await waitFor(() => expect(screen.queryByTestId("monday-board-changes")).toBeNull())
    })

    it("coming back to the tab re-reads the board, so a column added meanwhile shows up", async () => {
      mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink() })
      mocked.fetchMondayConnection.mockResolvedValue({ connected: true })
      mocked.fetchMondayBoardChanges.mockResolvedValue(changes([]))

      renderSection()
      await waitFor(() => expect(mocked.fetchMondayBoardChanges).toHaveBeenCalled())
      const before = mocked.fetchMondayBoardChanges.mock.calls.length
      mocked.fetchMondayLink.mockResolvedValue({ linked: true, link: makeLink({ structureStale: true }) })
      mocked.fetchMondayBoardChanges.mockResolvedValue(changes(["numeric_b"]))
      fireEvent(window, new Event("focus"))
      await waitFor(() => expect(mocked.fetchMondayBoardChanges.mock.calls.length).toBeGreaterThan(before))
      expect(await screen.findByRole("button", { name: /map it/i })).toBeTruthy()
    })
  })
})
