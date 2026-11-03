import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { expect, it, vi } from "vitest"
import { requestPasswordReset } from "@/lib/frontier/auth"
import { FrontierForgotPasswordForm } from "./FrontierForgotPasswordForm"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: null, loading: false, login: vi.fn() }),
}))
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ adopt: vi.fn() }),
}))
vi.mock("@/lib/frontier/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/frontier/auth")>(),
  requestPasswordReset: vi.fn(async () => {}),
}))

it("validates once and returns to sign-in (AQU-2300)", async () => {
  const onBack = vi.fn()
  render(<MemoryRouter><FrontierForgotPasswordForm onBack={onBack} /></MemoryRouter>)

  const email = screen.getByRole("textbox", { name: "Email" })
  const form = email.closest("form")!
  // Exercise the application's validator, including browsers that do not run
  // native email validation. Each invalid value produces exactly one message.
  for (const [value, expected] of [
    ["", "Email is required"],
    ["   ", "Email is required"],
    ["invalid", "Enter a valid email address"],
  ]) {
    fireEvent.change(email, { target: { value } })
    fireEvent.submit(form)
    expect(await screen.findByRole("alert")).toHaveTextContent(expected)
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(screen.queryByText(expected === "Email is required" ? "Enter a valid email address" : "Email is required")).toBeNull()
    expect(requestPasswordReset).not.toHaveBeenCalled()
  }

  fireEvent.change(email, { target: { value: " reader@example.com " } })
  fireEvent.submit(form)
  await screen.findByText("reader@example.com")
  expect(requestPasswordReset).toHaveBeenCalledExactlyOnceWith("reader@example.com", undefined)
  fireEvent.click(screen.getByRole("button", { name: "Back to login" }))
  expect(onBack).toHaveBeenCalledOnce()
})
