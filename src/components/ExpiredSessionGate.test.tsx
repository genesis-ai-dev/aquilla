import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { ExpiredSessionGate, isSessionGuardedPath } from "./ExpiredSessionGate"
import type { FrontierSession } from "@/lib/frontier/types"

// AQU-885. `isJwtExpired` is exercised for real — only the stored session is
// faked, since the whole point is that expiry is decided from the token alone.
let accountsValue: { active: FrontierSession | null; loading: boolean } = {
  active: null,
  loading: false,
}
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => accountsValue,
}))

/** Fake JWT with an `exp` claim `secondsFromNow` out. */
function fakeJwt(secondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `h.${btoa(JSON.stringify({ exp }))}.s`
}

function session(jwt: string): FrontierSession {
  return { jwt, username: "anna", createdAt: "2026-01-01T00:00:00Z" } as FrontierSession
}

/** Stands in for the login page and reports the ?next= it was handed. */
function LoginProbe() {
  const { search } = useLocation()
  return <div>login page{search}</div>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ExpiredSessionGate />
      <Routes>
        <Route path="/login" element={<LoginProbe />} />
        <Route path="*" element={<div>app shell</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  accountsValue = { active: null, loading: false }
})

describe("ExpiredSessionGate (AQU-885)", () => {
  it("sends a boot with an already-expired stored token to sign-in instead of the dashboard", () => {
    accountsValue = { active: session(fakeJwt(-60)), loading: false }
    renderAt("/orgs/all")
    expect(screen.getByText(/^login page/)).toBeInTheDocument()
    expect(screen.queryByText("app shell")).not.toBeInTheDocument()
  })

  it("preserves the originating route as ?next= so re-login lands back there", () => {
    accountsValue = { active: session(fakeJwt(-60)), loading: false }
    renderAt("/orgs/7?tab=projects")
    expect(
      screen.getByText(`login page?next=${encodeURIComponent("/orgs/7?tab=projects")}`),
    ).toBeInTheDocument()
  })

  it("leaves a valid unexpired session on the dashboard", () => {
    accountsValue = { active: session(fakeJwt(3600)), loading: false }
    renderAt("/orgs/all")
    expect(screen.getByText("app shell")).toBeInTheDocument()
  })

  it("does nothing while the stored session is still being read", () => {
    accountsValue = { active: null, loading: true }
    renderAt("/orgs/all")
    expect(screen.getByText("app shell")).toBeInTheDocument()
  })

  it("does nothing when there is no stored session at all", () => {
    renderAt("/orgs/all")
    expect(screen.getByText("app shell")).toBeInTheDocument()
  })

  it("leaves a malformed token alone rather than forcing a re-login it can't justify", () => {
    accountsValue = { active: session("not-a-jwt"), loading: false }
    renderAt("/orgs/all")
    expect(screen.getByText("app shell")).toBeInTheDocument()
  })

  it("does not bounce the invite flow, which carries its token in the URL", () => {
    accountsValue = { active: session(fakeJwt(-60)), loading: false }
    renderAt("/join/abc123")
    expect(screen.getByText("app shell")).toBeInTheDocument()
  })

  it("does not evict an expired session from the offline-capable project workspace", () => {
    accountsValue = { active: session(fakeJwt(-60)), loading: false }
    renderAt("/project/p1/editor")
    expect(screen.getByText("app shell")).toBeInTheDocument()
  })
})

describe("isSessionGuardedPath", () => {
  it("guards the signed-in shell routes", () => {
    for (const p of ["/", "/app", "/shared", "/orgs", "/orgs/all", "/orgs/7/members", "/projects", "/projects/p1"]) {
      expect(isSessionGuardedPath(p)).toBe(true)
    }
  })

  it("leaves public and offline-capable routes unguarded", () => {
    for (const p of [
      "/login",
      "/reset-password",
      "/verify-email",
      "/privacy-policy",
      "/onboarding",
      "/join/tok",
      "/join-org/tok",
      "/link/tok",
      "/approve/cs1",
      "/preferences",
      "/project/p1/editor",
      "/orgsomething",
    ]) {
      expect(isSessionGuardedPath(p)).toBe(false)
    }
  })
})
