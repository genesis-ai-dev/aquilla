// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ start: vi.fn(), clear: vi.fn() }))
vi.mock("@/lib/frontier/google-login", () => ({
  startGoogleLogin: mocks.start,
  clearGoogleAttempt: mocks.clear,
}))
vi.mock("@/lib/frontier/auth", () => ({
  AUTH_BASE: "https://identity.example.com",
}))
import { EmailChangeForm } from "./EmailChangeForm"
const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function renderForm(passwordAvailable = true) {
  return render(
    <MemoryRouter>
      <EmailChangeForm
        jwt="alice-token"
        username="alice"
        passwordAvailable={passwordAvailable}
        googleAvailable
        onBack={() => {}}
      />
    </MemoryRouter>,
  )
}
it("contacts no provider on mount and starts Google only on explicit action", () => {
  renderForm(false)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  mocks.start.mockResolvedValue(undefined)
  fireEvent.click(screen.getByRole("button", { name: "Verify with Google" }))
  expect(mocks.start).toHaveBeenCalledWith(
    "/preferences/login-methods",
    false,
    "alice",
    true,
  )
})
it("requires the destination code after ownership proof and reports success", async () => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ sent: true }))
    .mockResolvedValueOnce(Response.json({ changed: true }))
  renderForm()
  fireEvent.change(screen.getByLabelText("New email"), {
    target: { value: "new@example.com" },
  })
  fireEvent.change(screen.getByLabelText("Aquilla password"), {
    target: { value: "secret" },
  })
  fireEvent.click(
    screen.getByRole("button", { name: "Send verification email" }),
  )
  await screen.findByLabelText("Verification code")
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    email: "new@example.com",
    password: "secret",
  })
  fireEvent.change(screen.getByLabelText("Verification code"), {
    target: { value: "012345" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Confirm email change" }))
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "Log in" })).toBeTruthy(),
  )
  expect(mocks.clear).toHaveBeenCalledOnce()
})
it("shows an actionable dev access refusal without advancing", async () => {
  fetchMock.mockResolvedValue(
    Response.json(
      { error: "destination_dev_access_required" },
      { status: 403 },
    ),
  )
  renderForm()
  fireEvent.change(screen.getByLabelText("New email"), {
    target: { value: "new@example.com" },
  })
  fireEvent.change(screen.getByLabelText("Aquilla password"), {
    target: { value: "secret" },
  })
  fireEvent.click(
    screen.getByRole("button", { name: "Send verification email" }),
  )
  expect((await screen.findByRole("alert")).textContent).toContain(
    "dev access list",
  )
  expect(screen.queryByLabelText("Verification code")).toBeNull()
})
