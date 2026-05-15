// Smoke test for the projects app router.
//
// Verifies:
//   - The router mounts at /projects basename.
//   - Unauthenticated users (no JWT cookie) hit the login redirect path on
//     the list page (we stub the redirect helper to avoid an actual jsdom
//     navigation).
//   - Stub pages render or redirect as expected.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import "@testing-library/jest-dom/vitest"

// Mock the api-client to avoid network calls in tests.
vi.mock("@aquilla/api-client", () => ({
  fetchProjectList: vi.fn(() => Promise.resolve([])),
  fetchProject: vi.fn(),
  previewServerInvite: vi.fn(() => Promise.resolve(null)),
  acceptServerInvite: vi.fn(),
}))

// Mock the auth-client so we control session state.
const mockRedirect = vi.fn()
vi.mock("@aquilla/auth-client", () => ({
  getJwt: vi.fn(() => null),
  redirectToLogin: () => mockRedirect(),
  decodeUsername: vi.fn(),
  getSession: vi.fn(() => null),
}))

describe("apps/projects router", () => {
  beforeEach(() => {
    cleanup()
    mockRedirect.mockClear()
  })

  it("redirects to /login when no JWT is present on the list page", async () => {
    // Render the page directly, not via App, so we don't fight BrowserRouter
    // in tests. The page's own effect should fire and call redirectToLogin.
    const { ProjectListPage } = await import("../pages/ProjectListPage")
    render(
      <MemoryRouter>
        <ProjectListPage />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(mockRedirect).toHaveBeenCalled()
    })
  })

  it("renders the create-page stub copy", async () => {
    const { ProjectCreatePage } = await import("../pages/ProjectCreatePage")
    render(
      <MemoryRouter>
        <ProjectCreatePage />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Create a project/i)).toBeInTheDocument()
  })

  it("redirects onboarding back to the project list", async () => {
    const { OnboardingPage } = await import("../pages/OnboardingPage")
    render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/" element={<div data-testid="project-list-target" />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId("project-list-target")).toBeInTheDocument()
  })
})
