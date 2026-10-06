// AQU-731 — the org-roster hook's *state contract*, exercised through the real
// producer (`fetchOrgRoster`) rather than a hand-built result object, because
// the bug this covers was a lost distinction between the producer's three
// result kinds, not a wrong shape.
//
// `GET /orgs/:id/members` answers in four ways, and a caller that lets someone
// act on the roster needs to tell them apart:
//   200                       → ok, render the members
//   403 { rosterHidden:true } → hidden by org policy (AQU-485)
//   403 (no flag)             → caller isn't a member of this org (AQU-731)
//   any other non-2xx        → a real failure, surface the status
// Before AQU-731 the last three all reached callers as `members: []` with
// `error: null`, so StaffLanePopover could only say "no one in your
// organization yet" — the report that the Staff control "does nothing".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useOrgMembers } from "./useOrg"

vi.mock("./useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt-pm", username: "pm", createdAt: "x" },
    loading: false,
  }),
}))

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("useOrgMembers roster states", () => {
  it("200 → members, with neither hidden nor access-denied set", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        members: [{ userId: 10, username: "maria", role: { level: 400, name: "contributor" } }],
      }),
    )

    const { result } = renderHook(() => useOrgMembers(1))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.members).toHaveLength(1)
    expect(result.current.rosterHidden).toBe(false)
    expect(result.current.rosterAccessDenied).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("403 with rosterHidden → rosterHidden, NOT access-denied", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { rosterHidden: true }))

    const { result } = renderHook(() => useOrgMembers(1))

    await waitFor(() => expect(result.current.rosterHidden).toBe(true))
    expect(result.current.members).toEqual([])
    expect(result.current.rosterAccessDenied).toBe(false)
  })

  it("403 without the flag → rosterAccessDenied, NOT rosterHidden", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, {}))

    const { result } = renderHook(() => useOrgMembers(1))

    await waitFor(() => expect(result.current.rosterAccessDenied).toBe(true))
    expect(result.current.members).toEqual([])
    expect(result.current.rosterHidden).toBe(false)
    // Deliberately not an `error`: the caller is meant to explain the
    // situation, not show a red failure for a legitimate permission state.
    expect(result.current.error).toBeNull()
  })

  it("a later successful refresh clears a previous access-denied", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, {}))
    const { result } = renderHook(() => useOrgMembers(1))
    await waitFor(() => expect(result.current.rosterAccessDenied).toBe(true))

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        members: [{ userId: 10, username: "maria", role: { level: 400, name: "contributor" } }],
      }),
    )
    await result.current.refresh()

    await waitFor(() => expect(result.current.rosterAccessDenied).toBe(false))
    expect(result.current.members).toHaveLength(1)
  })

  it("a non-403 failure surfaces as error, not as a silent empty roster", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}))

    const { result } = renderHook(() => useOrgMembers(1))

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.rosterHidden).toBe(false)
    expect(result.current.rosterAccessDenied).toBe(false)
  })

  it("a null orgId never fires the request at all", async () => {
    const { result } = renderHook(() => useOrgMembers(null))

    await waitFor(() => expect(result.current.members).toEqual([]))
    expect(fetchMock).not.toHaveBeenCalled()
    // Nothing was attempted, so no flag claims to describe an outcome —
    // that is the case StaffLanePopover reads off the orgId prop instead.
    expect(result.current.rosterHidden).toBe(false)
    expect(result.current.rosterAccessDenied).toBe(false)
    expect(result.current.error).toBeNull()
  })
})
