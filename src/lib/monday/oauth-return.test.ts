// The two tabs of a Monday.com connect: the callback tab announces how it
// ended, and the tab that opened it stops waiting — on failure too, or after
// the state's lifetime when nothing arrives.

import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import {
  announceMondayOAuthOutcome,
  MONDAY_OAUTH_WAIT_MS,
  peekMondayOAuthState,
  toConnectFailure,
  useMondayOAuthOutcome,
} from "./oauth-return"

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const stateWith = (claims: object) => `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(claims))}.sig`

afterEach(() => {
  vi.useRealTimers()
})

describe("peekMondayOAuthState", () => {
  it("reads the org and return path the state was minted with", () => {
    expect(peekMondayOAuthState(stateWith({ orgId: 7, backTo: "/project/p1/settings/integrations" }))).toEqual({
      orgId: 7,
      backTo: "/project/p1/settings/integrations",
    })
  })

  it("never yields a return address outside the app", () => {
    expect(peekMondayOAuthState(stateWith({ orgId: 7, backTo: "//evil.example" })).backTo).toBeNull()
    expect(peekMondayOAuthState(stateWith({ orgId: 7, backTo: "https://evil.example" })).backTo).toBeNull()
  })

  it("survives a missing or garbled state", () => {
    expect(peekMondayOAuthState(null)).toEqual({ backTo: null, orgId: null })
    expect(peekMondayOAuthState("not-a-jwt")).toEqual({ backTo: null, orgId: null })
    expect(peekMondayOAuthState("a.%%%.c")).toEqual({ backTo: null, orgId: null })
  })
})

describe("toConnectFailure", () => {
  it("turns server and Monday slugs into the few reasons the UI explains", () => {
    expect(toConnectFailure("access_denied")).toBe("cancelled")
    expect(toConnectFailure("bad_state")).toBe("expired")
    expect(toConnectFailure("token_exchange_failed")).toBe("token_exchange_failed")
    expect(toConnectFailure("missing_params")).toBe("failed")
    expect(toConnectFailure("internal")).toBe("failed")
    expect(toConnectFailure(null)).toBe("failed")
  })
})

describe("useMondayOAuthOutcome", () => {
  it("hears the callback tab's failure for this org, and ignores another org's", async () => {
    const onOutcome = vi.fn()
    renderHook(() => useMondayOAuthOutcome(true, 7, onOutcome))

    announceMondayOAuthOutcome({ ok: false, reason: "cancelled", orgId: 8 })
    announceMondayOAuthOutcome({ ok: false, reason: "cancelled", orgId: 7 })

    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1))
    expect(onOutcome).toHaveBeenCalledWith({ ok: false, reason: "cancelled", orgId: 7 })
  })

  it("gives up with a timeout once the state could no longer succeed", () => {
    vi.useFakeTimers()
    const onOutcome = vi.fn()
    renderHook(() => useMondayOAuthOutcome(true, 7, onOutcome))
    vi.advanceTimersByTime(MONDAY_OAUTH_WAIT_MS - 1)
    expect(onOutcome).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onOutcome).toHaveBeenCalledWith({ ok: false, reason: "timeout", orgId: 7 })
  })

  it("listens only while waiting", () => {
    vi.useFakeTimers()
    const onOutcome = vi.fn()
    renderHook(() => useMondayOAuthOutcome(false, 7, onOutcome))
    vi.advanceTimersByTime(MONDAY_OAUTH_WAIT_MS * 2)
    expect(onOutcome).not.toHaveBeenCalled()
  })
})
