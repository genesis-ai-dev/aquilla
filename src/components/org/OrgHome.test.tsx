import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgHome } from "./OrgHome"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }) }))
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

beforeEach(() => localStorage.clear())
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
})
