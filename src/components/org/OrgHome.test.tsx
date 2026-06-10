import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgHome, activityStatus } from "./OrgHome"
import type { PortfolioProject } from "@/lib/frontier/portfolio"

// Default: signed-in. Type-cast to allow null session in signed-out tests.
type FakeSession = { jwt: string; username: string; createdAt: string } | null
const mockUseFrontierSession = vi.fn<[], { session: FakeSession; loading: boolean }>(() => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => mockUseFrontierSession() }))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))

// Mock getPortfolio but keep the real validatedPct/attentionRank
vi.mock("@/lib/frontier/portfolio", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/frontier/portfolio")>()
  const now = Date.now()
  return {
    ...actual,
    getPortfolio: vi.fn(async () => [
      // Stalled, low validated — should rank first
      {
        id: "stalled-1",
        name: "Legacy Translation",
        totalCells: 200,
        validatedCells: 20, // 10%
        lastEditAt: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago (stalled)
        audioCells: 100, // 50% audio
        recordedMs: 120000,
        deadlineAt: "2020-01-01", // long past → overdue
      },
      // Fresh, high validated — should rank second
      {
        id: "fresh-1",
        name: "New Testament",
        totalCells: 100,
        validatedCells: 90, // 90%
        lastEditAt: now, // just edited
        audioCells: 50, // 50% audio
        recordedMs: 60000,
        deadlineAt: null,
      },
    ]),
  }
})

// WorkloadRollup fetches this; empty here so it renders nothing and the
// portfolio-focused assertions below are unaffected.
vi.mock("@/lib/sync/assignments", () => ({ getWorkload: vi.fn(async () => []) }))

beforeEach(() => {
  localStorage.clear()
  mockUseFrontierSession.mockReturnValue({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false })
})
afterEach(() => vi.restoreAllMocks())

describe("OrgHome", () => {
  it("renders the org name, nav, and admin links for an owner", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getAllByText("Come and See").length).toBeGreaterThan(0))
    expect(screen.getByRole("link", { name: "Projects" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Teams" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Members" })).toBeInTheDocument()
  })

  it("renders both project names from the portfolio", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    expect(screen.getByText("New Testament")).toBeInTheDocument()
  })

  it("shows the project count in the rollup strip", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    // 2 projects total — rendered as the Projects rollup count
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("shows the overdue rollup card and an overdue badge", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    // "Overdue" appears twice: the rollup card label + the long-past-deadline row badge
    expect(screen.getAllByText("Overdue").length).toBeGreaterThan(1)
  })

  it("shows the audio rollup card and per-project audio %", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())
    expect(screen.getByText("Avg audio")).toBeInTheDocument()
    // both projects are 50% audio → at least one "50% audio" per-row label
    expect(screen.getAllByText("50% audio").length).toBeGreaterThan(0)
  })

  it("renders the stalled project before the fresh project (attention rank order)", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    const stalledEl = screen.getByText("Legacy Translation")
    const freshEl = screen.getByText("New Testament")

    // compareDocumentPosition: if stalledEl comes before freshEl,
    // freshEl.compareDocumentPosition(stalledEl) has the PRECEDING bit set (0x2)
    const position = freshEl.compareDocumentPosition(stalledEl)
    expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it("filters the project list by name without touching the rollup count", async () => {
    // Why: managers narrowing to one project must not see the portfolio
    // headline counts (e.g. total Projects = 2) silently change underneath them.
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("Filter projects by name"), {
      target: { value: "testament" },
    })

    expect(screen.queryByText("Legacy Translation")).not.toBeInTheDocument()
    expect(screen.getByText("New Testament")).toBeInTheDocument()
    // rollup count still reads the full portfolio of 2, not the filtered 1
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("filters to stalled projects via the status chip", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("New Testament")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "Stalled" }))

    // Legacy Translation is 30 days stale; New Testament was just edited.
    expect(screen.getByText("Legacy Translation")).toBeInTheDocument()
    expect(screen.queryByText("New Testament")).not.toBeInTheDocument()
  })

  it("shows a no-match message when the filter excludes every project", async () => {
    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByText("Legacy Translation")).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("Filter projects by name"), {
      target: { value: "nonexistent-zzz" },
    })

    expect(screen.getByText("No matching projects.")).toBeInTheDocument()
  })
})

// FRO-293: signed-out state — no fake-empty dashboard
describe("OrgHome signed-out state", () => {
  it("shows a sign-in prompt instead of zero-stat cards when there is no session", async () => {
    // Why: a signed-out user at / must never see '0 Projects / 0% translated' cards
    // which falsely imply the workspace is empty.
    mockUseFrontierSession.mockReturnValue({ session: null, loading: false })

    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)

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

    render(<MemoryRouter><OrgProvider><OrgHome /></OrgProvider></MemoryRouter>)

    const link = await screen.findByRole("link", { name: /sign in/i })
    expect(link.getAttribute("href")).toMatch(/\/login\?next=/)
  })
})

describe("activityStatus", () => {
  const now = Date.now()
  const base: PortfolioProject = {
    id: "p", name: "P", totalCells: 100, validatedCells: 0, filledCells: 0,
    lastEditAt: null, audioCells: 0, recordedMs: 0, deadlineAt: null,
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
