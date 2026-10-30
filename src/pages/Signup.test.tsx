import { renderWithBrand as render } from "@/test-utils/render-with-brand"
import { screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, expect, it, vi } from "vitest"
import { Signup } from "./Signup"

const auth = vi.hoisted(() => ({ session: null as null | { jwt: string; username: string }, loading: false, sessionLoadError: null as Error | null, retrySessionLoad: vi.fn(async () => {}), register: vi.fn(), login: vi.fn() }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => auth }))
vi.mock("@/lib/frontier/auth", async (load) => ({ ...await load<typeof import("@/lib/frontier/auth")>(), isJwtExpired: (jwt: string) => jwt === "expired" }))

function show(path = "/signup") {
  render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/signup" element={<Signup />} />
    <Route path="/onboarding" element={<Signup />} />
    <Route path="/app" element={<p>Workspace destination</p>} />
    <Route path="/join-org/:token" element={<p>Invitation destination</p>} />
    <Route path="/billing/select" element={<p>Billing destination</p>} />
  </Routes></MemoryRouter>)
}
beforeEach(() => {
  vi.clearAllMocks()
  auth.session = null
  auth.loading = false
  auth.sessionLoadError = null
  auth.register.mockResolvedValue({ jwt: "valid", username: "new-person" })
})

it.each([
  ["/signup", "Workspace destination"],
  ["/onboarding", "Workspace destination"],
  ["/signup?next=%2Fjoin-org%2Finvite", "Invitation destination"],
  ["/onboarding?offer=team&interval=annual&quantity=1", "Billing destination"],
  ["/signup?next=%2Fsignup", "Workspace destination"],
  ["/signup?next=https%3A%2F%2Fevil.test", "Workspace destination"],
])("registers directly and preserves a safe destination from %s", async (path, destination) => {
  show(path)
  expect(screen.queryByRole("progressbar")).toBeNull()
  expect(screen.queryByRole("button", { name: /skip for now/i })).toBeNull()
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "new-person" } })
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.test" } })
  fireEvent.change(document.getElementById("s-pass")!, { target: { value: "safe-password-123" } })
  fireEvent.submit(document.getElementById("signup-form")!)
  await screen.findByText(destination)
  expect(auth.register).toHaveBeenCalledExactlyOnceWith("new-person", "new@example.test", "safe-password-123")
  expect(localStorage.getItem("aquilla:onboardingComplete:local")).toBeNull()
})

it("does not assume signed out when session hydration fails, and retries", async () => {
  auth.sessionLoadError = new Error("storage unavailable")
  show()
  expect(screen.queryByLabelText("Username")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /retry/i }))
  await waitFor(() => expect(auth.retrySessionLoad).toHaveBeenCalledOnce())
})

it("uses a valid existing account without replaying setup", async () => {
  auth.session = { jwt: "valid", username: "existing" }
  show("/onboarding")
  await screen.findByText("Workspace destination")
  expect(auth.register).not.toHaveBeenCalled()
})
