import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { FrontierLoginForm } from "./FrontierLoginForm"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ login: vi.fn(async () => {}) }),
}))

function renderLogin(initialUsername?: string | null) {
  return render(
    <MemoryRouter>
      <FrontierLoginForm onSuccess={() => {}} initialUsername={initialUsername} />
    </MemoryRouter>,
  )
}

/**
 * AQU-1345: sign-up refuses an identity that already exists and sends the
 * reader here. The whole point of the redirection is that they do not retype
 * the name — so the field must arrive filled in, including when the value is
 * handed over after mount (the sign-up form resolves it from a failed submit).
 */
describe("FrontierLoginForm identifier prefill (AQU-1345)", () => {
  const LABEL = "Aquilla username or email"

  it("prefills the identifier field from initialUsername", () => {
    renderLogin("randall")
    expect(screen.getByLabelText(LABEL)).toHaveValue("randall")
  })

  it("leaves the field empty when no identifier is handed over", () => {
    renderLogin()
    expect(screen.getByLabelText(LABEL)).toHaveValue("")
  })

  it("adopts a late-arriving identifier but never overwrites the reader's own edit", () => {
    const { rerender } = render(
      <MemoryRouter>
        <FrontierLoginForm onSuccess={() => {}} initialUsername={null} />
      </MemoryRouter>,
    )
    const input = screen.getByLabelText(LABEL)
    expect(input).toHaveValue("")

    rerender(
      <MemoryRouter>
        <FrontierLoginForm onSuccess={() => {}} initialUsername="randall" />
      </MemoryRouter>,
    )
    expect(input).toHaveValue("randall")

    fireEvent.change(input, { target: { value: "randall@example.com" } })
    rerender(
      <MemoryRouter>
        <FrontierLoginForm onSuccess={() => {}} initialUsername="someone-else" />
      </MemoryRouter>,
    )
    expect(input).toHaveValue("randall@example.com")
  })
})
