/**
 * AbResultsPanel — per-model experiment outcomes. Verifies loading real rows
 * (acceptance computed over decided drafts only), the empty state, and that
 * the window buttons refetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AbResultsPanel } from "./AbResultsPanel"
import type { AbResultRow } from "@/lib/frontier/admin"

vi.mock("@/lib/frontier/admin", () => ({
  getAbResults: vi.fn(),
}))
import { getAbResults } from "@/lib/frontier/admin"
const mockGet = vi.mocked(getAbResults)

const ROWS: AbResultRow[] = [
  {
    model: "anthropic/claude-sonnet-4.5",
    arm: "champion",
    requests: 100,
    errors: 2,
    accepted: 30,
    edited: 10,
    rejected: 0,
    avgLatencyMs: 1500,
    avgEditDistance: 0.12,
  },
  {
    model: "anthropic/claude-haiku-4-5",
    arm: "challenger",
    requests: 25,
    errors: 0,
    accepted: 5,
    edited: 15,
    rejected: 0,
    avgLatencyMs: 800,
    avgEditDistance: 0.47,
  },
]

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe("AbResultsPanel", () => {
  it("renders per-model rows with acceptance over decided drafts", async () => {
    mockGet.mockResolvedValue({ days: 30, results: ROWS })
    render(<AbResultsPanel jwt="jwt" />)

    // champion: 30 accepted of 40 decided = 75%; challenger: 5 of 20 = 25%.
    expect(await screen.findByText(/75%/)).toBeInTheDocument()
    expect(screen.getByText(/25%/)).toBeInTheDocument()
    // Avg edit distance renders as "% rewritten": 0.12 → 12%, 0.47 → 47%.
    expect(screen.getByText("12%")).toBeInTheDocument()
    expect(screen.getByText("47%")).toBeInTheDocument()
    expect(screen.getByText("champion")).toBeInTheDocument()
    expect(screen.getByText("challenger")).toBeInTheDocument()
    expect(mockGet).toHaveBeenCalledWith("jwt", 30)
  })

  it("shows the empty state when no experiment data exists", async () => {
    mockGet.mockResolvedValue({ days: 30, results: [] })
    render(<AbResultsPanel jwt="jwt" />)
    expect(await screen.findByText(/no experiment data yet/i)).toBeInTheDocument()
  })

  it("refetches when the window changes", async () => {
    mockGet.mockResolvedValue({ days: 30, results: ROWS })
    render(<AbResultsPanel jwt="jwt" />)
    await screen.findByText(/75%/)

    fireEvent.click(screen.getByRole("button", { name: "7d" }))
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("jwt", 7))
  })
})
