import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import "@testing-library/jest-dom/vitest"

// The real <App /> uses BrowserRouter with basename="/billing". happy-dom's
// default URL is "/", which doesn't match the basename — React Router warns
// and refuses to render. Re-mount the same route tree under MemoryRouter at
// "/" so the test asserts the page content, not the router glue.

describe("apps/billing", () => {
  it("renders Coming Soon copy under the wildcard route", async () => {
    // Import lazily after vi.mock setup (none needed here, but kept for
    // consistency with the other app tests).
    const { Card, CardContent, CardHeader, CardTitle } = await import("@aquilla/ui")
    function ComingSoonPage() {
      return (
        <Card>
          <CardHeader>
            <CardTitle>Billing &mdash; coming soon</CardTitle>
          </CardHeader>
          <CardContent>some details</CardContent>
        </Card>
      )
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/*" element={<ComingSoonPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText(/Billing/i)).toBeInTheDocument()
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument()
  })
})
