import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import "@testing-library/jest-dom/vitest"

vi.mock("@aquilla/api-client", () => ({
  fetchUserOrgs: vi.fn(() => Promise.resolve(null)),
  fetchOrgMembers: vi.fn(() => Promise.resolve([])),
}))

const mockRedirect = vi.fn()
vi.mock("@aquilla/auth-client", () => ({
  getJwt: vi.fn(() => null),
  redirectToLogin: () => mockRedirect(),
}))

describe("apps/org pages", () => {
  beforeEach(() => {
    mockRedirect.mockClear()
  })

  it("redirects unauthenticated users from OrgListPage", async () => {
    const { OrgListPage } = await import("../pages/OrgListPage")
    render(
      <MemoryRouter>
        <OrgListPage />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(mockRedirect).toHaveBeenCalled()
    })
  })

  it("renders the invite-page stub copy", async () => {
    const { InvitePage } = await import("../pages/InvitePage")
    render(
      <MemoryRouter>
        <InvitePage />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Invite to multiple projects/i)).toBeInTheDocument()
  })
})
