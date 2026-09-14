import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AdminRetentionSection } from "./AdminRetentionSection"
import type { AdminRetention } from "@/lib/frontier/admin"

vi.mock("@/lib/frontier/admin", () => ({
  getAdminRetention: vi.fn(),
  sendAdminRetentionReport: vi.fn(),
}))

import { getAdminRetention, sendAdminRetentionReport } from "@/lib/frontier/admin"

const mockGet = vi.mocked(getAdminRetention)
const mockSend = vi.mocked(sendAdminRetentionReport)

const DATA: AdminRetention = {
  asOf: "2026-09-12",
  dau: 3,
  avgDau7: 4.5,
  wau: 12,
  mau: 40,
  stickiness: 4.5 / 40,
  newUsers7: 2,
  newUsers30: 9,
  totalUsers: 120,
  retention: {
    d1: { eligible: 100, retained: 50, rate: 0.5 },
    d7: { eligible: 90, retained: 36, rate: 0.4 },
    d30: { eligible: 60, retained: 0, rate: 0 },
  },
  daily: [
    { day: "2026-09-10", active: 0 },
    { day: "2026-09-11", active: 5 },
    { day: "2026-09-12", active: 3 },
  ],
  cohorts: [
    { weekStart: "2026-08-31", size: 4, retained: [4, 2] },
    { weekStart: "2026-09-07", size: 0, retained: [0] },
  ],
}

beforeEach(() => {
  mockGet.mockResolvedValue(DATA)
  mockSend.mockResolvedValue({ subject: "Aquilla retention — week ending 2026-09-13" })
})
afterEach(() => vi.clearAllMocks())

describe("AdminRetentionSection", () => {
  it("renders the active-user and retention tiles from the API", async () => {
    render(<AdminRetentionSection jwt="jwt" />)
    await waitFor(() => expect(screen.getByText("Daily active")).toBeInTheDocument())
    expect(mockGet).toHaveBeenCalledWith("jwt", 90)
    expect(screen.getByText("avg 4.5 over 7d")).toBeInTheDocument()
    expect(screen.getByText("12")).toBeInTheDocument() // WAU
    expect(screen.getByText("40")).toBeInTheDocument() // MAU
    expect(screen.getByText("11%")).toBeInTheDocument() // stickiness 4.5/40
    expect(screen.getByText("40%")).toBeInTheDocument() // D7
    expect(screen.getByText("36 of 90 eligible")).toBeInTheDocument()
    // D30 is a real 0%, not "—" (no eligible users) — the distinction matters.
    expect(screen.getByText("0%")).toBeInTheDocument()
  })

  it("draws one bar per day with the count in its tooltip", async () => {
    render(<AdminRetentionSection jwt="jwt" />)
    await waitFor(() => expect(screen.getAllByTestId("dau-bar")).toHaveLength(3))
    const bars = screen.getAllByTestId("dau-bar")
    expect(bars[1]).toHaveAttribute("data-day", "2026-09-11")
    expect(bars[1].querySelector("title")?.textContent).toBe("2026-09-11: 5 active")
  })

  it("shows cohorts newest first as share-of-cohort, with '—' for an empty cohort", async () => {
    render(<AdminRetentionSection jwt="jwt" />)
    const rows = await screen.findAllByTestId("cohort-row")
    expect(rows.map((r) => r.getAttribute("data-week"))).toEqual(["2026-09-07", "2026-08-31"])
    // 2026-08-31: 4 signups, w0 100%, w1 50%
    expect(rows[1]).toHaveTextContent("100%")
    expect(rows[1]).toHaveTextContent("50%")
    expect(rows[0]).toHaveTextContent("—")
  })

  it("emails the recap on demand and confirms the subject", async () => {
    render(<AdminRetentionSection jwt="jwt" />)
    const btn = await screen.findByRole("button", { name: /email weekly recap/i })
    fireEvent.click(btn)
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("jwt", "weekly"))
    expect(await screen.findByText("Sent: Aquilla retention — week ending 2026-09-13")).toBeInTheDocument()
  })

  it("surfaces a load error instead of an empty dashboard", async () => {
    mockGet.mockRejectedValueOnce(new Error("HTTP 500"))
    render(<AdminRetentionSection jwt="jwt" />)
    expect(await screen.findByText("HTTP 500")).toBeInTheDocument()
  })
})
