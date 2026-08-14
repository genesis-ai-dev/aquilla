import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { FrontierSignupForm } from "./FrontierSignupForm"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ register: vi.fn(async () => {}) }),
}))

describe("FrontierSignupForm password checklist + show/hide", () => {
  it("toggles #s-pass type via Show/Hide password", () => {
    render(<FrontierSignupForm onSuccess={() => {}} />)

    const input = document.getElementById("s-pass") as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input).toHaveAttribute("type", "password")

    fireEvent.click(screen.getByRole("button", { name: /Show password/i }))
    expect(input).toHaveAttribute("type", "text")
    expect(screen.getByRole("button", { name: /Hide password/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /Hide password/i }))
    expect(input).toHaveAttribute("type", "password")
  })

  it("shows weak strength for a short password and the 8-character requirement", () => {
    render(<FrontierSignupForm onSuccess={() => {}} />)

    const input = document.getElementById("s-pass") as HTMLInputElement
    fireEvent.change(input, { target: { value: "abc" } })

    expect(screen.getByText(/Strength: weak/i)).toBeInTheDocument()
    expect(screen.getByText(/At least 8 characters/i)).toBeInTheDocument()
  })

  it("shows strong strength for a long mixed password", () => {
    render(<FrontierSignupForm onSuccess={() => {}} />)

    const input = document.getElementById("s-pass") as HTMLInputElement
    fireEvent.change(input, { target: { value: "Tr@nsl8r!99" } })

    expect(screen.getByText(/Strength: strong/i)).toBeInTheDocument()
  })
})
