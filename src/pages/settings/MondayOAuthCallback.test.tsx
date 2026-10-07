// /oauth/callback — a failed or cancelled connect explains itself in plain
// words, "Back to Aquilla" returns to the org's Monday settings carrying the
// failure, and the waiting tab is told.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { MondayOAuthCallback } from "./MondayOAuthCallback"
import { completeMondayOAuth } from "@/lib/monday/api"
import { announceMondayOAuthOutcome } from "@/lib/monday/oauth-return"

vi.mock("@/lib/monday/api", () => ({ completeMondayOAuth: vi.fn() }))
vi.mock("@/lib/monday/oauth-return", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/monday/oauth-return")>()),
  announceMondayOAuthOutcome: vi.fn(),
}))

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const STATE = `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify({ orgId: 7, backTo: "/orgs/7/settings/monday" }))}.sig`

function Landed() {
  const loc = useLocation()
  return <p data-testid="landed">{loc.pathname + loc.search}</p>
}

function renderAt(search: string) {
  render(
    <MemoryRouter initialEntries={[`/oauth/callback${search}`]}>
      <Routes>
        <Route path="/oauth/callback" element={<MondayOAuthCallback />} />
        <Route path="*" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe("MondayOAuthCallback", () => {
  it("a connect cancelled in Monday says so plainly and goes back to the org's Monday settings", async () => {
    renderAt(`?error=access_denied&state=${STATE}`)

    expect(await screen.findByText(/cancelled in Monday\.com/i)).toBeTruthy()
    expect(screen.queryByText(/missing code or state/i)).toBeNull()
    expect(screen.getByRole("link", { name: /back to aquilla/i }).getAttribute("href")).toBe(
      "/orgs/7/settings/monday?monday=error&reason=cancelled",
    )
    expect(announceMondayOAuthOutcome).toHaveBeenCalledWith({ ok: false, reason: "cancelled", orgId: 7 })
    expect(completeMondayOAuth).not.toHaveBeenCalled()
  })

  it("an approval that came back too late explains the 10-minute limit, not 'bad_state'", async () => {
    vi.mocked(completeMondayOAuth).mockResolvedValue({ ok: false, reason: "bad_state" })
    renderAt(`?code=c1&state=${STATE}`)

    expect(await screen.findByText(/within 10 minutes/i)).toBeTruthy()
    expect(screen.queryByText(/bad_state/)).toBeNull()
    expect(screen.getByRole("link", { name: /back to aquilla/i }).getAttribute("href")).toBe(
      "/orgs/7/settings/monday?monday=error&reason=expired",
    )
    expect(announceMondayOAuthOutcome).toHaveBeenCalledWith({ ok: false, reason: "expired", orgId: 7 })
  })

  it("a successful exchange tells the waiting tab and returns to backTo", async () => {
    vi.mocked(completeMondayOAuth).mockResolvedValue({ ok: true, backTo: "/orgs/7/settings/monday" })
    renderAt(`?code=c1&state=${STATE}`)

    await waitFor(() =>
      expect(screen.getByTestId("landed").textContent).toBe("/orgs/7/settings/monday?monday=connected"),
    )
    expect(announceMondayOAuthOutcome).toHaveBeenCalledWith({ ok: true, orgId: 7 })
  })
})
