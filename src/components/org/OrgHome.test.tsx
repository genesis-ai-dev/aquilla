import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectTable, activityStatus, OrgHome } from "./OrgHome"
import { OrgOverview } from "./OrgOverview"
import { OrgProjectsPage } from "./OrgProjectsPage"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"
import type { PortfolioProject } from "@/lib/frontier/portfolio"

function projectsRollupStat() {
  // Overview (and all-orgs) rollup tiles sit outside the nav. The label lives
  // in a nested wrapper so the tile can be a single row on small screens.
  const label = screen.getAllByText("Projects").find((el) => !el.closest("nav"))!
  const tile = label.parentElement?.parentElement
  if (!tile) throw new Error("rollup tile root not found")
  return tile
}

function renderMemberShell(path: string) {
  return renderWithTooltips(
    <MemoryRouter initialEntries={[path]}>
      <OrgProvider>
        <Routes>
          <Route path="/orgs/:orgId/overview" element={<OrgOverview />} />
          <Route path="/orgs/:orgId/projects" element={<OrgProjectsPage />} />
        </Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

function renderMemberOverview() {
  return renderMemberShell("/orgs/1/overview")
}

function renderMemberProjects() {
  return renderMemberShell("/orgs/1/projects")
}

// Default: signed-in. Type-cast to allow null session in signed-out tests.
type FakeSession = { jwt: string; username: string; createdAt: string } | null
const mockUseFrontierSession = vi.fn<() => { session: FakeSession; loading: boolean }>(() => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => mockUseFrontierSession() }))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }))
vi.mock("./OrgSwitcher", () => ({ OrgSwitcher: () => null }))
vi.mock("@/hooks/usePlatformAdmin", () => ({ usePlatformAdmin: () => ({ isAdmin: false, loading: false }) }))

// Mock portfolio fetch; keep real metrics helpers. Project list data is built
// inside the factory so vi.hoist does not race with outer constants.
vi.mock("@/lib/frontier/portfolio", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/frontier/portfolio")>()
  const now = Date.now()
  const projects = [
    {
      id: "stalled-1",
      name: "Legacy Translation",
      totalCells: 200,
      validatedCells: 20,
      filledCells: 20,
      aiDraftedCells: 0,
      lastEditAt: now - 30 * 24 * 60 * 60 * 1000,
      audioCells: 100,
      validatedAudioCells: 0,
      recordedMs: 120000,
      deadlineAt: "2020-01-01",
      sourceLanguage: null,
      targetLanguage: null,
    },
    {
      id: "fresh-1",
      name: "New Testament",
      totalCells: 100,
      validatedCells: 90,
      filledCells: 90,
      aiDraftedCells: 0,
      lastEditAt: now,
      audioCells: 50,
      validatedAudioCells: 0,
      recordedMs: 60000,
      deadlineAt: null,
      sourceLanguage: null,
      targetLanguage: null,
    },
  ]
  return {
    ...actual,
    getPortfolio: vi.fn(async () => projects),
    // AQU-883: the all-orgs dashboard fans out through getPortfolios; tests
    // that exercise that scope override this (default matches the member
    // overview fixture so overview assertions stay hermetic).
    getPortfolios: vi.fn(async () => [{ orgId: 1, projects }]),
  }
})

// WorkloadRollup fetches this; empty here so it renders nothing and the
// portfolio-focused assertions below are unaffected.
vi.mock("@/lib/sync/assignments", () => ({ getWorkload: vi.fn(async () => []) }))

// AQU-335/AQU-416: accessible-projects feed for foreign-org grants (and
// OrgProvider's guest-org derivation). Default empty — the all-orgs Shared
// origin test overrides it with a foreign-org grant.
const fetchAccessibleProjectsMock = vi.fn(async (): Promise<unknown[]> => [])
vi.mock("@/lib/sync/cloud-projects", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sync/cloud-projects")>()
  return {
    ...actual,
    fetchAccessibleProjects: () => fetchAccessibleProjectsMock(),
    fetchAccessibleProjectsResult: async () => ({
      ok: true as const,
      projects: await fetchAccessibleProjectsMock(),
    }),
  }
})

// AQU-326: pending-invites card data source. Default empty; individual tests
// override to assert the card renders.
const listMyPendingInvitesMock = vi.fn(async (): Promise<unknown[]> => [])
vi.mock("@/lib/sync/invites", () => ({
  listMyPendingInvites: () => listMyPendingInvitesMock(),
}))

// AQU-486: useOrgSettings backs Team workload / Team usage visibility
// (memberProgressViewMinRole). Mocked hermetically (same pattern as
// Settings.test.tsx / ProjectOverview.test.tsx) instead of hitting real fetch.
type OrgSettingsMock = ReturnType<typeof import("@/hooks/useOrgSettings").useOrgSettings>
const defaultOrgSettingsMock = (): OrgSettingsMock => ({
  settings: {},
  orgRules: [],
  promotionRequests: [],
  canRequestPromotion: false,
  version: 1,
  hasFetched: true,
  canEdit: true,
  canEditOrgKeys: true,
  orgProviderKeys: {},
  canExport: true,
  exportMinRole: null,
  canViewRoster: true,
  rosterViewMinRole: 600,
  canViewMemberProgress: true,
  memberProgressViewMinRole: 600,
  // AQU-496: default leads-only (matches the server's safe default).
  allowSelfAssignment: false,
  countStructuralCells: true,
  countStructuralOverrides: 0,
  resetCountStructuralOverrides: vi.fn(),
  // AQU-822: default termbase-edit floor (project_lead), as the server resolves it.
  termbaseEditMinRole: 500,
  refresh: vi.fn(async () => null),
  patch: vi.fn(async () => ({ kind: "ok" as const, value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } })),
  requestPromotion: vi.fn(async () => ({ kind: "blocked" as const })),
})
const useOrgSettingsMock = vi.fn<() => OrgSettingsMock>(defaultOrgSettingsMock)
const canEditRosterProgressFloorMock = vi.fn((level: number | null | undefined) => (level ?? 0) >= 700)
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => useOrgSettingsMock(),
  canEditRosterProgressFloor: (level: number | null | undefined) => canEditRosterProgressFloorMock(level),
}))

beforeEach(async () => {
  localStorage.clear()
  mockUseFrontierSession.mockReturnValue({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false })
  // AQU-486: reset the org list back to the default (owner) — the
  // below-floor visibility test overrides this to a contributor-level org,
  // and restoreAllMocks does not undo a persistent mockResolvedValue.
  const { listMyOrgs } = await import("@/lib/frontier/orgs")
  vi.mocked(listMyOrgs).mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }])
  const { getWorkload } = await import("@/lib/sync/assignments")
  vi.mocked(getWorkload).mockResolvedValue([])
  const { getPortfolio } = await import("@/lib/frontier/portfolio")
  vi.mocked(getPortfolio).mockImplementation(async () => {
    const now = Date.now()
    return [
      {
        id: "stalled-1",
        name: "Legacy Translation",
        totalCells: 200,
        validatedCells: 20,
        filledCells: 20,
        aiDraftedCells: 0,
        lastEditAt: now - 30 * 24 * 60 * 60 * 1000,
        audioCells: 100,
        validatedAudioCells: 0,
        recordedMs: 120000,
        deadlineAt: "2020-01-01",
        sourceLanguage: null,
        targetLanguage: null,
      },
      {
        id: "fresh-1",
        name: "New Testament",
        totalCells: 100,
        validatedCells: 90,
        filledCells: 90,
        aiDraftedCells: 0,
        lastEditAt: now,
        audioCells: 50,
        validatedAudioCells: 0,
        recordedMs: 60000,
        deadlineAt: null,
        sourceLanguage: null,
        targetLanguage: null,
      },
    ]
  })
  // Reset to the default (no invites); the pending-invites test overrides this.
  // restoreAllMocks does not reset vi.fn implementations, so without this a
  // mockResolvedValue set in one test would leak into the next.
  listMyPendingInvitesMock.mockResolvedValue([])
  // Same leak-guard for the accessible-projects feed (shared-section test).
  fetchAccessibleProjectsMock.mockResolvedValue([])
  // AQU-486: reset the org-settings mock to its default (everything visible,
  // maintainer floor) — restoreAllMocks does not undo a persistent
  // mockReturnValue set by an earlier test.
  useOrgSettingsMock.mockReturnValue(defaultOrgSettingsMock())
  canEditRosterProgressFloorMock.mockImplementation((level: number | null | undefined) => (level ?? 0) >= 700)
})
afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth")
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth")
})

function mockProjectNameOverflow(overflowing: boolean) {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => (overflowing ? 400 : 80),
  })
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 128,
  })
}

describe("OrgHome loading template", () => {
  it("keeps the header breadcrumb-only (no trailing profile chip)", () => {
    mockUseFrontierSession.mockReturnValue({
      session: { jwt: "jwt", username: "anna", createdAt: "x" },
      loading: true,
    })
    render(
      <MemoryRouter initialEntries={["/orgs/all"]}>
        <OrgProvider>
          <OrgHome />
        </OrgProvider>
      </MemoryRouter>,
    )
    expect(screen.getByTestId("org-home-loading-template")).toBeInTheDocument()
    const header = document.querySelector("[data-slot='app-shell-header']")
    expect(header).not.toBeNull()
    expect(header!.querySelectorAll("[data-slot='skeleton']")).toHaveLength(1)
  })
})

describe("ProjectTable", () => {
  const project: PortfolioProject & { orgName: string } = {
    id: "long-project",
    name: "A project name that must remain readable beside its organization",
    orgName: "Come and See Foundation International",
    totalCells: 100,
    filledCells: 40,
    validatedCells: 20,
    aiDraftedCells: 0,
    lastEditAt: Date.now(),
    audioCells: 10,
    validatedAudioCells: 0,
    recordedMs: 0,
    deadlineAt: "2020-01-01",
    sourceLanguage: "English",
    targetLanguage: "French",
  }

  it("keeps the organization secondary while preserving a compact project identity", async () => {
    mockProjectNameOverflow(true)
    renderWithTooltips(
      <MemoryRouter>
        <ProjectTable
          projects={[project]}
          now={Date.now()}
          showOrg
          // AQU-606: this map is only the per-file *hint*; the project's own
          // targetLanguage ("French") takes precedence for the '' lane chip.
          defaultLaneLabelByProjectId={new Map([[project.id, "conversational Spanish"]])}
        />
      </MemoryRouter>,
    )

    expect(screen.getByText("Project")).toBeInTheDocument()
    expect(screen.getByText("Org")).toBeInTheDocument()
    const identity = screen.getByTestId("project-table-identity")
    const projectName = screen.getByTestId("project-table-name")
    const expandedProjectName = screen.getByTestId("project-table-name-expanded")
    const organization = screen.getByTestId("project-table-organization")
    const metadata = screen.getByTestId("project-table-metadata")
    const deadlineTrigger = screen.getByTestId("project-table-deadline-trigger")
    const deadlineStatus = screen.getByTestId("project-table-deadline-status")
    expect(projectName).toHaveTextContent(project.name)
    expect(projectName).toHaveClass("overflow-hidden", "whitespace-nowrap", "text-clip")
    expect(projectName).not.toHaveClass("truncate", "text-ellipsis")
    expect(organization).toHaveTextContent(project.orgName)
    expect(identity).toContainElement(projectName)
    expect(identity).toContainElement(organization)
    expect(projectName).not.toHaveAttribute("title")
    expect(
      [...(projectName.closest("a")?.querySelectorAll("[title]") ?? [])].filter(
        (element) => element.getAttribute("title") === project.name,
      ),
    ).toHaveLength(0)
    expect(projectName).not.toHaveAttribute("data-slot", "tooltip-trigger")
    expect(projectName.parentElement).toHaveAttribute("data-project-name-truncated", "true")
    expect(expandedProjectName).toHaveTextContent(project.name)
    expect(expandedProjectName).toHaveAttribute("aria-hidden", "true")
    expect(expandedProjectName).toHaveClass("z-50", "-start-2", "px-2", "py-1", "bg-popover", "shadow-md")
    expect(organization).not.toHaveAttribute("data-slot", "tooltip-trigger")
    expect(identity).toHaveClass("@md/project-table:grid-cols-[minmax(6.5rem,1fr)_minmax(4rem,6rem)]")
    expect(organization).toHaveClass("relative", "h-5", "w-full")
    expect(organization).toHaveAttribute("data-org-name", project.orgName)
    expect(organization.querySelectorAll('[data-slot="badge"]')).toHaveLength(1)
    expect(metadata).toHaveTextContent("English → French")
    expect(identity).toContainElement(deadlineTrigger)
    expect(deadlineTrigger).toContainElement(deadlineStatus)
    expect(deadlineStatus).toHaveTextContent("Overdue")
    expect(deadlineStatus).toHaveClass("[&>span:last-child]:sr-only")
    expect(metadata).not.toContainElement(deadlineStatus)
    expect(organization).not.toContainElement(deadlineStatus)
    expect(screen.getByTestId("project-table")).toHaveClass("overflow-hidden")
    expect(screen.getByTestId("project-table")).not.toHaveClass("overflow-x-auto")
    const languages = screen.getByTestId("project-table-languages")
    const languageChip = screen.getByTestId(`lane-chip-${project.id}-`)
    expect(languages).toHaveClass("min-w-0", "overflow-hidden")
    expect(languageChip.parentElement).toHaveClass("w-full", "min-w-0", "max-w-full")
    expect(languageChip).toHaveClass("min-w-0", "max-w-full", "overflow-hidden")
    expect(within(languageChip).getByText("French")).toHaveClass("min-w-0", "flex-1", "truncate")
    expect(languageChip).toHaveAccessibleName("French: 40% translated")
    // The (potentially truncated) label's full text stays recoverable on hover.
    await expectTooltip(languageChip, "French — 40% translated")
    expect(screen.getByText("Language")).toBeInTheDocument()
    expect(screen.getByTestId("project-table-translated-header")).toHaveAttribute("aria-label", "Translated")
    expect(screen.getByTestId("project-table-validated-header")).toHaveAttribute("aria-label", "Validated")
    expect(screen.getByTestId("project-table-audio-header")).toHaveAttribute("aria-label", "Has audio")
    expect(screen.getByTestId("project-table-translated-value")).toHaveClass("justify-self-start", "text-start")
    expect(screen.getByTestId("project-table-validated-value")).toHaveClass("justify-self-start", "text-start")
    expect(screen.getByTestId("project-table-audio-value")).toHaveClass("justify-self-start", "text-start")
    expect(screen.queryByText("Role")).not.toBeInTheDocument()
    expect(screen.queryByText("Updated", { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText(/Updated /)).not.toBeInTheDocument()
  })

  it("labels the default lane from the project's target language with no per-file hint (AQU-606)", async () => {
    // The all-orgs table passes an empty hint map, and a lanes-migrated project
    // carries no per-file targetLanguage — the chip used to read "Default".
    renderWithTooltips(
      <MemoryRouter>
        <ProjectTable projects={[project]} now={Date.now()} showOrg />
      </MemoryRouter>,
    )

    const chip = screen.getByTestId(`lane-chip-${project.id}-`)
    expect(chip).toHaveTextContent("French")
    expect(chip).not.toHaveTextContent("Default")
    // A long target language still truncates but stays recoverable on hover.
    expect(within(chip).getByText("French")).toHaveClass("min-w-0", "flex-1", "truncate")
    await expectTooltip(chip, "French — 40% translated")
  })

  it("falls back to the neutral placeholder when no target language is set (AQU-606)", () => {
    render(
      <MemoryRouter>
        <ProjectTable
          projects={[{ ...project, id: "untargeted", targetLanguage: null }]}
          now={Date.now()}
          showOrg
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId("lane-chip-untargeted-")).toHaveTextContent("Default")
  })

  it("omits the redundant organization column in a single-organization view", () => {
    render(
      <MemoryRouter>
        <ProjectTable projects={[project]} now={Date.now()} showOrg={false} />
      </MemoryRouter>,
    )

    expect(screen.queryByTestId("project-table-organization")).not.toBeInTheDocument()
    expect(screen.getByTestId("project-table-name")).toHaveTextContent(project.name)
  })

  it("does not reveal or tooltip a project name that fits", () => {
    mockProjectNameOverflow(false)
    render(
      <MemoryRouter>
        <ProjectTable projects={[{ ...project, id: "exodus", name: "Exodus" }]} now={Date.now()} showOrg />
      </MemoryRouter>,
    )

    const projectName = screen.getByTestId("project-table-name")
    expect(projectName).toHaveTextContent("Exodus")
    expect(projectName).not.toHaveAttribute("title")
    expect(projectName).not.toHaveAttribute("data-slot", "tooltip-trigger")
    expect(projectName.parentElement).toHaveAttribute("data-project-name-truncated", "false")
    expect(screen.queryByTestId("project-table-name-expanded")).not.toBeInTheDocument()
  })
})

describe("OrgOverview / OrgProjects", () => {
  it("never paints a false-empty projects page while the current portfolio is unresolved", async () => {
    const { getPortfolio } = await import("@/lib/frontier/portfolio")
    let resolvePortfolio!: (projects: PortfolioProject[]) => void
    vi.mocked(getPortfolio).mockImplementation(
      () => new Promise((resolve) => { resolvePortfolio = resolve }),
    )

    const container = document.createElement("div")
    document.body.appendChild(container)
    const addedText: string[] = []
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) addedText.push(node.textContent ?? "")
      }
    })
    observer.observe(container, { childList: true, subtree: true })

    const view = render(
      <MemoryRouter initialEntries={["/orgs/1/projects"]}>
        <OrgProvider>
          <Routes>
            <Route path="/orgs/:orgId/projects" element={<OrgProjectsPage />} />
          </Routes>
        </OrgProvider>
      </MemoryRouter>,
      { container },
    )

    try {
      await waitFor(() =>
        expect(screen.getByRole("status", { name: "Loading projects" })).toBeInTheDocument(),
      )
      expect(screen.getByPlaceholderText("Search projects…")).toBeInTheDocument()
      expect(document.querySelector('[data-slot="app-shell-header"]')).not.toBeNull()
      expect(screen.queryByTestId("loading-neutral-template")).not.toBeInTheDocument()
      await act(async () => { await Promise.resolve() })
      // Description is unique to the resolved zero-projects empty state; the
      // title ("No projects yet") is also the loading-table placeholder.
      expect(addedText.join("\n")).not.toContain("Create a project to start translating.")

      // Keep subsequent refetches empty so the empty-state isn't replaced by default mock data.
      vi.mocked(getPortfolio).mockResolvedValue([])
      await act(async () => { resolvePortfolio([]) })
      await waitFor(() =>
        expect(screen.queryByRole("status", { name: "Loading projects" })).not.toBeInTheDocument(),
      )
      expect(screen.getByText("No projects yet")).toBeInTheDocument()
      expect(screen.getByText("Create a project to start translating.")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Invite your team" })).not.toBeInTheDocument()
      expect(screen.getByPlaceholderText("Search projects…")).toBeInTheDocument()
    } finally {
      observer.disconnect()
      view.unmount()
      container.remove()
    }
  })

  // AQU-882: `/orgs/all` renders OrgHome directly — it's a sibling route of
  // `/orgs/:orgId`, so OrgRouteGate (the only surface that read the org-load
  // error) never mounts for it. A failed fetch therefore fell through to the
  // ordinary dashboard and rendered as "you have no organizations". The error
  // card lives in the AQU-864 landing guard, so it only renders on the
  // `/orgs/all` route — these tests mount there, as the app does.
  describe("organization load failure (AQU-882)", () => {
    async function renderWithFailedOrgLoad(message = "network down") {
      const { listMyOrgs } = await import("@/lib/frontier/orgs")
      vi.mocked(listMyOrgs).mockRejectedValue(new Error(message))
      render(
        <MemoryRouter initialEntries={["/orgs/all"]}>
          <OrgProvider><OrgHome /></OrgProvider>
        </MemoryRouter>,
      )
      return await screen.findByTestId("org-load-error")
    }

    it("shows an error card with Retry instead of the zero-stat empty dashboard", async () => {
      const card = await renderWithFailedOrgLoad()
      expect(within(card).getByText(/couldn’t load your organizations/i)).toBeInTheDocument()
      expect(within(card).getByRole("button", { name: /retry/i })).toBeInTheDocument()
      // The repro's misleading surfaces must be gone, not merely accompanied.
      expect(screen.queryByText("No organizations yet.")).not.toBeInTheDocument()
      expect(screen.queryByText("No projects yet.")).not.toBeInTheDocument()
      expect(screen.queryByTestId("organizations-panel")).not.toBeInTheDocument()
    })

    it("surfaces the failure reason so the error isn't generic", async () => {
      const card = await renderWithFailedOrgLoad("identity worker unreachable")
      expect(within(card).getByText("identity worker unreachable")).toBeInTheDocument()
    })

    it("loads organizations and projects in place when Retry is clicked — no page reload", async () => {
      const card = await renderWithFailedOrgLoad()
      const { listMyOrgs } = await import("@/lib/frontier/orgs")
      // Backend is reachable again.
      vi.mocked(listMyOrgs).mockResolvedValue([
        { id: 1, name: "Come and See", role: { level: 700, name: "owner" } },
        { id: 2, name: "Side Org", role: { level: 700, name: "owner" } },
      ])

      const { getPortfolios } = await import("@/lib/frontier/portfolio")
      const portfolioCallsBeforeRetry = vi.mocked(getPortfolios).mock.calls.length

      fireEvent.click(within(card).getByRole("button", { name: /retry/i }))

      // Same mount: the dashboard replaces the error card.
      await waitFor(() => expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0))
      expect(screen.queryByTestId("org-load-error")).not.toBeInTheDocument()
      // Retry re-issues the dependent portfolio fetch too, not just the orgs —
      // the failure state resolves to real data rather than an empty dashboard.
      await waitFor(() =>
        expect(vi.mocked(getPortfolios).mock.calls.length).toBeGreaterThan(portfolioCallsBeforeRetry),
      )
    })

    it("does not show the error card when the fetch succeeds with zero organizations", async () => {
      // Negative case: genuinely belonging to no org is an empty state, not a
      // failure — it must keep rendering the ordinary dashboard chrome.
      const { listMyOrgs } = await import("@/lib/frontier/orgs")
      vi.mocked(listMyOrgs).mockResolvedValue([])
      render(
        <MemoryRouter initialEntries={["/orgs/all"]}>
          <OrgProvider><OrgHome /></OrgProvider>
        </MemoryRouter>,
      )
      await waitFor(() =>
        expect(screen.queryByTestId("org-home-loading")).not.toBeInTheDocument(),
      )
      expect(screen.queryByTestId("org-load-error")).not.toBeInTheDocument()
    })
  })

  it("renders the org name, nav, and admin links for an owner", async () => {
    renderMemberOverview()
    await waitFor(() => expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0))
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Projects" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Teams" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Members" })).toBeInTheDocument()
  })

  it("renders both project names from the portfolio", async () => {
    renderMemberProjects()
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    expect(screen.getByText("New Testament")).toBeInTheDocument()
  })

  // AQU-326: an invite addressed to the user's email must be discoverable
  // in-app — the email/link may never have arrived. Review & accept routes
  // to the /join/:token confirmation page (explicit accept per AQU-335).
  it("renders the Pending invitations card with a Review & accept link", async () => {
    // mockResolvedValue (not ...Once): the invite effect can run more than
    // once (e.g. once before orgs load, once after), and a second call returning
    // the default [] would unmount the card mid-assertion.
    listMyPendingInvitesMock.mockResolvedValue([
      {
        token: "tok-pending-1",
        role: { level: 400, name: "contributor" },
        createdBy: "wendi",
        createdAt: "2026-06-12T00:00:00Z",
        expiresAt: null,
        projects: [{ projectId: "p9", projectName: "Ruth Translation" }],
      },
    ])
    renderMemberOverview()
    // Wait for the first portfolio to settle so the dashboard content is mounted.
    await waitFor(() => {
      const card = screen.getByTestId("pending-invitations")
      expect(card).toHaveTextContent("Ruth Translation")
      expect(card).toHaveTextContent(/invited by wendi/i)
      const link = screen.getByRole("link", { name: /review & accept/i })
      expect(link.getAttribute("href")).toBe("/join/tok-pending-1")
    })
  })

  it("renders no Pending invitations card when there are none", async () => {
    renderMemberOverview()
    await waitFor(() => expect(screen.getByTestId("org-overview-projects-table")).toBeInTheDocument())
    expect(screen.queryByTestId("pending-invitations")).not.toBeInTheDocument()
  })

  it("shows the project count in the rollup strip", async () => {
    renderMemberOverview()
    await waitFor(() => expect(screen.getByText("Avg translated")).toBeInTheDocument())
    const projectsStat = projectsRollupStat()
    expect(within(projectsStat).getByText("2")).toBeInTheDocument()
    expect(projectsStat).toHaveClass("flex-row-reverse")
    expect(projectsStat.parentElement).toHaveClass("grid-cols-1")
  })

  it("shows the overdue rollup card and at-risk rows on overview", async () => {
    renderMemberOverview()
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    expect(screen.getAllByText("Overdue").length).toBeGreaterThan(0)
  })

  it("shows every project directly in recent-update order", async () => {
    renderMemberOverview()

    const table = await screen.findByTestId("org-overview-projects-table")
    const recentProject = within(table).getByText("New Testament")
    const staleProject = within(table).getByText("Legacy Translation")

    expect(staleProject.compareDocumentPosition(recentProject) & Node.DOCUMENT_POSITION_PRECEDING)
      .toBeTruthy()
    expect(within(staleProject.closest("tr")!).queryByRole("img", { name: /needs attention/i }))
      .not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /view projects/i })).not.toBeInTheDocument()
  })

  it("shows the ten most recently updated projects first and expands the rest inline", async () => {
    const { getPortfolio } = await import("@/lib/frontier/portfolio")
    const now = Date.now()
    vi.mocked(getPortfolio).mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        id: `project-${index + 1}`,
        name: `Project ${String(index + 1).padStart(2, "0")}`,
        totalCells: 100,
        validatedCells: 50,
        filledCells: 50,
        aiDraftedCells: 0,
        lastEditAt: now - index * 1_000,
        audioCells: 0,
        validatedAudioCells: 0,
        recordedMs: 0,
        deadlineAt: null,
        sourceLanguage: null,
        targetLanguage: null,
      })),
    )

    renderMemberOverview()

    const table = await screen.findByTestId("org-overview-projects-table")
    expect(within(table).getByText("Project 01")).toBeInTheDocument()
    expect(within(table).getByText("Project 10")).toBeInTheDocument()
    expect(within(table).queryByText("Project 11")).not.toBeInTheDocument()

    const showAll = within(table).getByRole("button", { name: "Show 2 more" })
    expect(showAll).toHaveAttribute("aria-expanded", "false")
    expect(showAll.closest("tr")).toBe(table.querySelector("tbody tr:last-child"))
    fireEvent.click(showAll)

    expect(within(table).getByText("Project 11")).toBeInTheDocument()
    expect(within(table).getByText("Project 12")).toBeInTheDocument()
    const showFewer = within(table).getByRole("button", { name: "Show fewer" })
    expect(showFewer).toHaveAttribute("aria-expanded", "true")
    expect(showFewer.closest("tr")).toBe(table.querySelector("tbody tr:last-child"))

    fireEvent.click(showFewer)
    expect(within(table).queryByText("Project 11")).not.toBeInTheDocument()
  })

  it("shows the audio rollup card and per-project audio % on the projects table", async () => {
    renderMemberOverview()
    await waitFor(() => expect(screen.getByText("Avg audio")).toBeInTheDocument())
  })

  it("shows per-project audio % on the projects table", async () => {
    renderMemberProjects()
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    // Scope to the row so the bare "50%" cell isn't confused with a rollup tile.
    const legacyRow = screen.getByText("Legacy Translation").closest("tr")
    const freshRow = screen.getByText("New Testament").closest("tr")
    expect(legacyRow).not.toBeNull()
    expect(freshRow).not.toBeNull()
    expect(within(legacyRow!).getByText("50%")).toBeInTheDocument()
    expect(within(freshRow!).getByText("50%")).toBeInTheDocument()
  })

  it("labels every compact metric heading for assistive technology", async () => {
    renderMemberProjects()
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    // Projects page uses OrgProjectsDataTable sortable headers (not ProjectTable's icon headers).
    for (const name of [/^Translated$/i, /^Validated$/i, /^Audio$/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument()
    }
  })

  it("renders the stalled project before the fresh project (attention rank order)", async () => {
    // The default lens is now "recent" (most-recently-edited first); this test
    // specifically verifies the attention-rank ordering, so select that lens.
    localStorage.setItem("org:all-projects:view", "attention")
    renderMemberProjects()
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    const stalledEl = screen.getByText("Legacy Translation")
    const freshEl = screen.getByText("New Testament")

    // compareDocumentPosition: if stalledEl comes before freshEl,
    // freshEl.compareDocumentPosition(stalledEl) has the PRECEDING bit set (0x2)
    const position = freshEl.compareDocumentPosition(stalledEl)
    expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it("filters the project list by name", async () => {
    renderMemberProjects()
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("Search projects…"), {
      target: { value: "testament" },
    })

    expect(screen.queryByText("Legacy Translation")).not.toBeInTheDocument()
    expect(screen.getByText("New Testament")).toBeInTheDocument()
  })

  it("filters to stalled projects via the Sort by menu's Status submenu", async () => {
    renderMemberProjects()
    await waitFor(() => expect(screen.getByText("New Testament")).toBeInTheDocument())

    // AQU-1044: on the Projects page the status filter lives in the combined
    // Sort by menu (ProjectSortMenu), one submenu per dimension.
    fireEvent.click(screen.getByTestId("project-sort-menu"))
    fireEvent.click(await screen.findByRole("menuitem", { name: /^status/i }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Stalled" }))
    fireEvent.pointerDown(document.body, { button: 0 })
    await waitFor(() => {
      expect(screen.queryAllByRole("menu")).toHaveLength(0)
    })

    // Legacy Translation is 30 days stale; New Testament was just edited.
    expect(screen.getByText("Legacy Translation")).toBeInTheDocument()
    expect(screen.queryByText("New Testament")).not.toBeInTheDocument()
  })

  it("filters to projects that need attention via the Sort by menu's Status submenu", async () => {
    renderMemberProjects()
    await waitFor(() => expect(screen.getByText("New Testament")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("project-sort-menu"))
    fireEvent.click(await screen.findByRole("menuitem", { name: /^status/i }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Needs attention" }))
    fireEvent.pointerDown(document.body, { button: 0 })
    await waitFor(() => {
      expect(screen.queryAllByRole("menu")).toHaveLength(0)
    })

    // Legacy Translation is overdue + stalled; New Testament is healthy.
    expect(screen.getByText("Legacy Translation")).toBeInTheDocument()
    expect(screen.queryByText("New Testament")).not.toBeInTheDocument()
  })

  it("shows a no-match message when the filter excludes every project", async () => {
    renderMemberProjects()
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("Search projects…"), {
      target: { value: "nonexistent-zzz" },
    })

    await waitFor(() => {
      expect(screen.queryByText("Legacy Translation")).not.toBeInTheDocument()
    })
    expect(screen.getByText("No projects match your search.")).toBeInTheDocument()
  })

  // AQU-417: cross-org grants are no longer listed on a single org's
  // dashboard — they were scattered under every org's project list. They
  // now live on `/orgs/all` as Shared-origin rows. The org overview must
  // NOT render a Shared with you section, even when the caller holds a
  // foreign-org grant.
  it("does not render a Shared with you section on the org overview (moved to /orgs/all)", async () => {
    fetchAccessibleProjectsMock.mockResolvedValue([
      // In the caller's own org (id 1) — surfaces via the normal portfolio.
      { id: "own-1", name: "Legacy Translation", orgId: 1, role: { level: 700, name: "owner", source: "creator" }, files: [] },
      // Foreign-org grant (viewer via invite) — collected on /orgs/all, not here.
      { id: "p503", name: "Guest Gospel", orgId: 503, orgName: "Host Org", role: { level: 100, name: "viewer", source: "override" }, files: [] },
    ])

    renderMemberOverview()

    // Wait for the org portfolio to render before asserting absence.
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    expect(screen.queryByTestId("shared-with-you")).not.toBeInTheDocument()
    expect(screen.queryByText("Guest Gospel")).not.toBeInTheDocument()
  })

  it("does not list foreign-org grants on a single org's Projects table (AQU-417)", async () => {
    fetchAccessibleProjectsMock.mockResolvedValue([
      { id: "own-1", name: "Legacy Translation", orgId: 1, role: { level: 700, name: "owner", source: "creator" }, files: [] },
      { id: "p503", name: "Guest Gospel", orgId: 503, orgName: "Host Org", role: { level: 100, name: "viewer", source: "override" }, files: [] },
    ])

    renderMemberProjects()

    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    expect(screen.queryByText("Guest Gospel")).not.toBeInTheDocument()
    expect(screen.queryByTestId("shared-filter-chip")).not.toBeInTheDocument()
    expect(screen.queryByTestId("project-shared-badge")).not.toBeInTheDocument()
  })
})

// ── AQU-486: per-section visibility chrome ──────────────────────────────────

describe("OrgOverview per-section visibility (AQU-486)", () => {
  // WHY: Team workload / Team usage are per-member productivity views gated
  // by the AQU-485 memberProgressViewMinRole floor. A below-floor caller must
  // see nothing (no empty section leaking that workload/usage tracking
  // exists); a permitted caller sees the section with a badge naming who can
  // see it, and — if they can edit — an inline control to change the floor.

  it("hides the Team workload section entirely for a caller below the memberProgressViewMinRole floor", async () => {
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 600, // Maintainer floor
    })
    // Contributor-level org role — below the Maintainer floor.
    const { listMyOrgs } = await import("@/lib/frontier/orgs")
    vi.mocked(listMyOrgs).mockResolvedValue([{ id: 1, name: "Come and See", role: { level: 400, name: "contributor" } }])

    renderMemberOverview()
    await waitFor(() => expect(screen.getByText("Avg translated")).toBeInTheDocument())

    expect(screen.queryByTestId("section-team-workload")).not.toBeInTheDocument()
    expect(screen.queryByTestId("section-team-usage")).not.toBeInTheDocument()
  })

  it("shows the Team workload section with a visibility badge for a caller meeting the floor", async () => {
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 600,
    })
    const { getWorkload } = await import("@/lib/sync/assignments")
    vi.mocked(getWorkload).mockResolvedValue([
      { assignmentId: "a1", projectId: "p1", projectName: "Legacy Translation", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 4, deadline: null },
    ])
    // Default org role in this suite is 700 (owner) — meets the floor.
    renderMemberOverview()
    await waitFor(() => expect(screen.getByText("Avg translated")).toBeInTheDocument())

    const section = await screen.findByTestId("section-team-workload")
    expect(within(section).getByTestId("section-visibility-badge")).toHaveTextContent(/maintainers & owners/i)
  })

  it("a maintainer can change the Team workload floor via the inline advanced toggle", async () => {
    const patch = vi.fn(async () => ({ kind: "ok" as const, value: { orgId: 1, settings: {}, version: 2, updatedAt: null, updatedBy: null } }))
    useOrgSettingsMock.mockReturnValue({
      ...defaultOrgSettingsMock(),
      memberProgressViewMinRole: 600,
      patch,
    })
    canEditRosterProgressFloorMock.mockReturnValue(true)
    const { getWorkload } = await import("@/lib/sync/assignments")
    vi.mocked(getWorkload).mockResolvedValue([
      { assignmentId: "a1", projectId: "p1", projectName: "Legacy Translation", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 4, deadline: null },
    ])

    renderMemberOverview()
    await waitFor(() => expect(screen.getByText("Avg translated")).toBeInTheDocument())

    const section = await screen.findByTestId("section-team-workload")
    const visibilityButton = await within(section).findByRole("button", {
      name: /change section visibility/i,
    })
    fireEvent.click(visibilityButton)

    const trigger = await screen.findByRole("combobox", { name: /who can see this section/i })
    fireEvent.click(trigger)
    const option = await screen.findByRole("option", { name: /everyone with access/i })
    fireEvent.pointerMove(option)
    fireEvent.mouseMove(option)
    fireEvent.keyDown(option, { key: "Enter" })

    await waitFor(() => expect(patch).toHaveBeenCalledWith({ memberProgressViewMinRole: 100 }))
  })
})

// AQU-293: signed-out state — no fake-empty dashboard
describe("OrgOverview signed-out state", () => {
  it("shows a sign-in prompt instead of zero-stat cards when there is no session", async () => {
    // Why: a signed-out user at / must never see '0 Projects / 0% translated' cards
    // which falsely imply the workspace is empty.
    mockUseFrontierSession.mockReturnValue({ session: null, loading: false })

    renderMemberOverview()

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument()
    })

    // The stat rollup cards must not be present — they'd show meaningless zeros.
    expect(screen.queryByText("0%")).not.toBeInTheDocument()
    expect(screen.queryByText("Avg translated")).not.toBeInTheDocument()
    expect(screen.queryByText("No projects in this org yet.")).not.toBeInTheDocument()
  })

  it("sign-in link on the signed-out state points to /login with next=/", async () => {
    mockUseFrontierSession.mockReturnValue({ session: null, loading: false })

    renderMemberOverview()

    const link = await screen.findByRole("link", { name: /sign in/i })
    expect(link.getAttribute("href")).toMatch(/\/login\?next=/)
  })
})

describe("activityStatus", () => {
  const now = Date.now()
  const base: PortfolioProject = {
    id: "p", name: "P", totalCells: 100, validatedCells: 0, filledCells: 0, aiDraftedCells: 0,
    lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null,
    sourceLanguage: null, targetLanguage: null,
  }

  it("treats a never-edited, never-translated project as not-started, not stalled", () => {
    // Why: a freshly seeded project hasn't lost momentum — flagging it red as
    // "Stalled" misleads the owner-oversight dashboard.
    expect(activityStatus({ ...base, lastEditAt: null, filledCells: 0 }, now)).toBe("not-started")
  })

  it("treats a project that had activity then went quiet 14+ days as stalled", () => {
    expect(
      activityStatus({ ...base, lastEditAt: now - 30 * 24 * 60 * 60 * 1000, filledCells: 50 }, now),
    ).toBe("stalled")
  })

  it("treats translated-but-never-timestamped work as stalled, not not-started", () => {
    // filledCells > 0 means real work exists even if lastEditAt is missing.
    expect(activityStatus({ ...base, lastEditAt: null, filledCells: 10 }, now)).toBe("stalled")
  })

  it("treats a recently edited project as active", () => {
    expect(activityStatus({ ...base, lastEditAt: now, filledCells: 5 }, now)).toBe("active")
  })
})

// AQU-883: the project directory (accessible-projects) is the only source of
// shared/guest projects and the guest orgs derived from them. Its fetch used to
// collapse every failure into an empty list with no error recorded anywhere, so
// the all-orgs overview was indistinguishable from "nothing is shared with you".
describe("OrgHome — project-directory load failure (AQU-883)", () => {
  const twoOrgs = [
    { id: 1, name: "Come and See", role: { level: 700, name: "owner" } },
    { id: 2, name: "Side Org", role: { level: 700, name: "owner" } },
  ]

  async function renderAllOrgs(
    portfolios: Array<{ orgId: number; projects: unknown[] }> = [],
  ) {
    const { listMyOrgs } = await import("@/lib/frontier/orgs")
    vi.mocked(listMyOrgs).mockResolvedValue(twoOrgs)
    const { getPortfolios } = await import("@/lib/frontier/portfolio")
    vi.mocked(getPortfolios).mockResolvedValue(portfolios as never)
    return render(
      <MemoryRouter initialEntries={["/orgs/all"]}>
        <OrgProvider><OrgHome /></OrgProvider>
      </MemoryRouter>,
    )
  }

  it("surfaces the failure in the projects panel instead of a plain empty state", async () => {
    fetchAccessibleProjectsMock.mockRejectedValue(new Error("Failed to fetch"))
    await renderAllOrgs()

    const errorCard = await screen.findByTestId("project-directory-error")
    expect(errorCard).toBeInTheDocument()
    // Member orgs loaded fine, so the org panel must NOT claim a failure...
    expect(screen.getByText("Come and See")).toBeInTheDocument()
    // ...and the misleading "No projects yet." must not stand in for the error.
    expect(screen.queryByText("No projects yet.")).not.toBeInTheDocument()
    expect(within(errorCard).getByRole("button", { name: /retry/i })).toBeInTheDocument()
  })

  it("Retry re-fetches the directory in place and clears the error", async () => {
    fetchAccessibleProjectsMock.mockRejectedValueOnce(new Error("Failed to fetch"))
    await renderAllOrgs()

    const errorCard = await screen.findByTestId("project-directory-error")
    fetchAccessibleProjectsMock.mockResolvedValue([])
    await act(async () => {
      fireEvent.click(within(errorCard).getByRole("button", { name: /retry/i }))
    })

    await waitFor(() =>
      expect(screen.queryByTestId("project-directory-error")).not.toBeInTheDocument(),
    )
    expect(fetchAccessibleProjectsMock.mock.calls.length).toBeGreaterThan(1)
  })

  it("negative case: a genuinely empty directory keeps the normal empty presentation", async () => {
    fetchAccessibleProjectsMock.mockResolvedValue([])
    await renderAllOrgs()

    await waitFor(() => expect(screen.getByText("Come and See")).toBeInTheDocument())
    expect(screen.queryByTestId("project-directory-error")).not.toBeInTheDocument()
    expect(screen.getByText("No projects yet")).toBeInTheDocument()
  })

  it("lists foreign-org grants in the projects table as a Shared origin, without mixing them into org rollup tiles", async () => {
    fetchAccessibleProjectsMock.mockResolvedValue([
      {
        id: "p503",
        name: "Guest Gospel",
        orgId: 503,
        orgName: "Host Org",
        role: { level: 100, name: "viewer", source: "override" },
        grantedAt: "2026-07-20T00:00:00Z",
        files: [],
      },
    ])
    await renderAllOrgs([
      { orgId: 1, projects: [{
        id: "own-1",
        name: "Legacy Translation",
        totalCells: 200,
        validatedCells: 20,
        filledCells: 20,
        aiDraftedCells: 0,
        lastEditAt: Date.now(),
        audioCells: 0,
        validatedAudioCells: 0,
        recordedMs: 0,
        deadlineAt: null,
      }] },
      { orgId: 2, projects: [] },
    ])

    expect(await screen.findByText("Guest Gospel")).toBeInTheDocument()
    expect(screen.getByText("Legacy Translation")).toBeInTheDocument()
    expect(screen.getByTestId("project-shared-badge")).toBeInTheDocument()
    // Soft fill — secondary/muted match the table surface in this theme.
    expect(screen.getByTestId("project-shared-badge")).toHaveClass("bg-foreground/10")
    expect(screen.getByTestId("project-shared-badge")).toHaveClass("text-muted-foreground")
    expect(screen.getByText("Host Org")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Org" })).toBeInTheDocument()
    expect(screen.getByTestId("shared-filter-chip")).toBeInTheDocument()
    const originTabs = within(screen.getByRole("tablist")).getAllByRole("tab")
    expect(originTabs.map((tab) => tab.textContent)).toEqual(["All", "SharedNew", "Org"])
    expect(screen.getByTestId("new-shared-nav-badge")).toBeInTheDocument()
    expect(screen.getByTestId("organizations-panel")).toBeInTheDocument()
    // Member rollup only — mixing the 0%-of-N shared stub would make this 2
    // projects and 5% avg translated.
    expect(within(projectsRollupStat()).getByText("1")).toBeInTheDocument()
    const avgTile = screen.getByText("Avg translated").parentElement?.parentElement
    expect(avgTile).toBeTruthy()
    expect(within(avgTile!).getByText("10%")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("shared-filter-chip"))
    await waitFor(() => {
      expect(screen.queryByText("Legacy Translation")).not.toBeInTheDocument()
    })
    expect(screen.getByText("Guest Gospel")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: "Org" }))
    await waitFor(() => {
      expect(screen.queryByText("Guest Gospel")).not.toBeInTheDocument()
    })
    expect(screen.getByText("Legacy Translation")).toBeInTheDocument()
  })
})
