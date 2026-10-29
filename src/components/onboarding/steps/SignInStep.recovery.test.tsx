import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { expect, it, vi } from "vitest"
import { requestPasswordReset } from "@/lib/frontier/auth"
import { SignInStep } from "./SignInStep"

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

it("keeps recovery in its own flow, validates once, and returns to sign-in without advancing onboarding (AQU-2300)", async () => {
  const onNext = vi.fn()
  const onBack = vi.fn()
  render(<MemoryRouter><SignInStep onNext={onNext} onBack={onBack} /></MemoryRouter>)
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
  fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }))

  expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull()
  expect(screen.queryByRole("button", { name: /Dev login/ })).toBeNull()

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
  expect(requestPasswordReset).toHaveBeenCalledExactlyOnceWith("reader@example.com")
  fireEvent.click(screen.getByRole("button", { name: "Back to login" }))
  expect(screen.getByRole("textbox", { name: "Aquilla username or email" })).toBeVisible()
  expect(onNext).not.toHaveBeenCalled()
  expect(onBack).not.toHaveBeenCalled()
})
