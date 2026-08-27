import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { ExpiredSessionGate } from "./ExpiredSessionGate"
import { Login } from "@/pages/Login"

function fakeJwt(secondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `h.${btoa(JSON.stringify({ exp }))}.s`
}

const expiredSession = { jwt: fakeJwt(-60), username: "alice", createdAt: "x" }
const freshSession = { jwt: fakeJwt(3600), username: "alice", createdAt: "y" }
let storedSession = expiredSession
const login = vi.fn(async () => {
  storedSession = freshSession
  return freshSession
})

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: expiredSession, sessions: [], loading: false }),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: expiredSession, loading: false, login }),
}))
vi.mock("@/lib/frontier/session-store", () => ({
  loadActiveSession: () => Promise.resolve(storedSession),
}))
vi.mock("@/components/git-import/FrontierForgotPasswordForm", () => ({
  FrontierForgotPasswordForm: () => null,
}))

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}{location.search}</div>
}

describe("expired-session redirect and re-login composition", () => {
  it("shows the form once and does not bounce a fresh stored JWT back to login", async () => {
    storedSession = expiredSession
    login.mockClear()
    render(
      <MemoryRouter initialEntries={["/orgs/all"]}>
        <ExpiredSessionGate />
        <LocationProbe />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/orgs/all" element={<div>all orgs</div>} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByLabelText(/username or email/i)).toBeInTheDocument()
    expect(screen.getByTestId("location")).toHaveTextContent("/login?next=%2Forgs%2Fall")

    fireEvent.change(screen.getByLabelText(/username or email/i), { target: { value: "alice" } })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } })
    fireEvent.submit(document.getElementById("login-form")!)

    await waitFor(() => expect(login).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/orgs/all"))
    expect(screen.getByText("all orgs")).toBeInTheDocument()
    expect(screen.queryByLabelText(/username or email/i)).not.toBeInTheDocument()
  })
})
