// Tests for UsageSection: the personal usage preferences section.
//
// WHY these tests matter: UsageSection fetches the user's audio and AI usage
// totals and history. The tests encode the INTENT — callers (Preferences page)
// need to know that (a) today's totals display correctly, (b) the section is
// invisible when signed out (so no blank card shows), and (c) it renders nothing
// but a loading state while fetching rather than stale zeros.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { UsageSection } from "./UsageSection"
import type { MyUsage } from "@/lib/sync/usage"

// Mock the usage client lib
vi.mock("@/lib/sync/usage", () => ({ getMyUsage: vi.fn() }))
// Mock the session hook: default returns a signed-in session
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: vi.fn(() => ({ session: { jwt: "test-jwt" }, loading: false })),
}))

import { getMyUsage } from "@/lib/sync/usage"
import { useFrontierSession } from "@/hooks/useFrontierSession"

const mockGetMyUsage = vi.mocked(getMyUsage)
const mockUseFrontierSession = vi.mocked(useFrontierSession)

const FULL_USAGE: MyUsage = {
  today: { audioSeconds: 125, ttsRequests: 3, llmRequests: 7 },
  history: [
    { date: "2026-06-07", audioSeconds: 60, ttsRequests: 1, llmRequests: 2 },
    { date: "2026-06-08", audioSeconds: 0, ttsRequests: 0, llmRequests: 0 },
    { date: "2026-06-09", audioSeconds: 90, ttsRequests: 2, llmRequests: 3 },
    { date: "2026-06-10", audioSeconds: 30, ttsRequests: 1, llmRequests: 0 },
    { date: "2026-06-11", audioSeconds: 0, ttsRequests: 0, llmRequests: 1 },
    { date: "2026-06-12", audioSeconds: 45, ttsRequests: 1, llmRequests: 2 },
    { date: "2026-06-13", audioSeconds: 125, ttsRequests: 3, llmRequests: 7 },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  // Restore signed-in session as default so the signed-out test doesn't
  // bleed into subsequent tests.
  mockUseFrontierSession.mockReturnValue({
    session: { jwt: "test-jwt" } as ReturnType<typeof useFrontierSession>["session"],
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  })
})
afterEach(() => vi.restoreAllMocks())

describe("UsageSection", () => {
  it("renders today's totals (audio minutes and AI request count) when data is available", async () => {
    // WHY: the primary value of this section is showing the user their current
    // day's activity. If it renders wrong numbers the UI lies about real usage.
    mockGetMyUsage.mockResolvedValue(FULL_USAGE)
    render(<UsageSection />)

    await waitFor(() => expect(screen.getByText("This week")).toBeInTheDocument())

    // 125 s = 2 min 5 s
    expect(screen.getByText("2 min 5 s")).toBeInTheDocument()
    // 3 TTS + 7 LLM = 10 AI requests
    expect(screen.getByText("10")).toBeInTheDocument()
    expect(mockGetMyUsage).toHaveBeenCalledWith("test-jwt")
  })

  it("renders a 7-day bar chart label for the history", async () => {
    // WHY: history visualisation is the secondary value (trend awareness). If
    // the chart area is missing, callers of this section have no trend data.
    mockGetMyUsage.mockResolvedValue(FULL_USAGE)
    render(<UsageSection />)

    await waitFor(() => expect(screen.getByText("7-day audio history")).toBeInTheDocument())
    // Should have 7 bars (one per day in history)
    const bars = screen.getByLabelText("7-day audio history bar chart").children
    expect(bars).toHaveLength(7)
  })

  it("renders nothing (null) when no session is present (user is signed out)", () => {
    // WHY: signed-out visitors should never see a blank usage card.
    mockUseFrontierSession.mockReturnValue({
      session: null,
      loading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    })
    const { container } = render(<UsageSection />)
    expect(container).toBeEmptyDOMElement()
    // Should not call the endpoint for anonymous visitors
    expect(mockGetMyUsage).not.toHaveBeenCalled()
  })

  it("shows 'No usage recorded yet.' when endpoint returns zeros", async () => {
    // WHY: new users shouldn't see mysterious zeros — a friendly empty state
    // is clearer than "0 s audio" when no activity has been recorded.
    const zero: MyUsage = {
      today: { audioSeconds: 0, ttsRequests: 0, llmRequests: 0 },
      history: [],
    }
    mockGetMyUsage.mockResolvedValue(zero)
    render(<UsageSection />)

    await waitFor(() => expect(mockGetMyUsage).toHaveBeenCalled())
    expect(screen.getByText("No usage recorded yet.")).toBeInTheDocument()
  })

  it("swallows fetch errors gracefully (shows empty state, not an error banner)", async () => {
    // WHY: the usage section is decorative — a transient failure should not
    // block the whole Preferences page or show a scary error message.
    mockGetMyUsage.mockRejectedValue(new Error("network error"))
    render(<UsageSection />)

    await waitFor(() => expect(mockGetMyUsage).toHaveBeenCalled())
    // Error is swallowed: no banner, falls through to no-data state
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument()
    expect(screen.getByText("No usage recorded yet.")).toBeInTheDocument()
  })
})
