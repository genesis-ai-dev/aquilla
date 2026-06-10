/**
 * FRO-270: NotFound (404 catch-all) page tests
 */

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { NotFound } from "./NotFound"

function renderUnknown() {
  return render(
    <MemoryRouter initialEntries={["/no-such-route"]}>
      <Routes>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("NotFound", () => {
  it("renders 'Page not found' heading", () => {
    renderUnknown()
    expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument()
  })

  it("renders a link back to home", () => {
    renderUnknown()
    const link = screen.getByRole("link", { name: /go home/i })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute("href", "/")
  })
})
