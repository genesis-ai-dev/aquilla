import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { FrontierSignupForm } from "./FrontierSignupForm"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ register: vi.fn(async () => {}) }),
}))

// AQU-338: the invite flow passes the bound recipient email via initialEmail;
// the field must render prefilled, adopt a late-arriving value, and yield to the
// user once they edit it.
describe("FrontierSignupForm email prefill (AQU-338)", () => {
  it("prefills the email input from initialEmail", () => {
    render(<FrontierSignupForm onSuccess={() => {}} initialEmail="invitee@example.com" />)
    expect(screen.getByLabelText("Email")).toHaveValue("invitee@example.com")
  })

  it("leaves the email empty when no initialEmail is given", () => {
    render(<FrontierSignupForm onSuccess={() => {}} />)
    expect(screen.getByLabelText("Email")).toHaveValue("")
  })

  it("adopts a late-arriving initialEmail but stops once the user edits the field", () => {
    const { rerender } = render(<FrontierSignupForm onSuccess={() => {}} initialEmail={null} />)
    const input = screen.getByLabelText("Email")
    expect(input).toHaveValue("")

    // Preview resolves after mount → the prefill lands.
    rerender(<FrontierSignupForm onSuccess={() => {}} initialEmail="invitee@example.com" />)
    expect(input).toHaveValue("invitee@example.com")

    // User overrides it → later prop changes must not clobber their input.
    fireEvent.change(input, { target: { value: "me@myown.com" } })
    rerender(<FrontierSignupForm onSuccess={() => {}} initialEmail="changed@example.com" />)
    expect(input).toHaveValue("me@myown.com")
  })
})
