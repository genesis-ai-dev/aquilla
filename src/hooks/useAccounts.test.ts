import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAccounts } from "./useAccounts"
import {
  _resetDbForTesting, addSession, sessionKey,
} from "@/lib/frontier/session-store"

describe("useAccounts", () => {
  beforeEach(async () => { await _resetDbForTesting() })

  it("returns empty state initially", async () => {
    const { result } = renderHook(() => useAccounts())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.active).toBeNull()
    expect(result.current.sessions).toHaveLength(0)
  })

  it("reflects sessions after add", async () => {
    await addSession({
      jwt: "x", gitlabToken: "g", gitlabUrl: "https://git.example.com",
      username: "ada", createdAt: "2026-01-01T00:00:00Z",
    })
    const { result } = renderHook(() => useAccounts())
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.active?.username).toBe("ada")
  })

  it("activate swaps active session", async () => {
    await addSession({
      jwt: "x", gitlabToken: "g", gitlabUrl: "https://git.example.com",
      username: "ryder", createdAt: "2026-01-01T00:00:00Z",
    })
    await addSession({
      jwt: "y", gitlabToken: "g", gitlabUrl: "https://git.example.com",
      username: "ada", createdAt: "2026-01-02T00:00:00Z",
    })
    const { result } = renderHook(() => useAccounts())
    await waitFor(() => expect(result.current.sessions).toHaveLength(2))
    const adaKey = sessionKey({
      jwt: "y", gitlabToken: "g", gitlabUrl: "https://git.example.com",
      username: "ada", createdAt: "2026-01-02T00:00:00Z",
    })
    await act(async () => { await result.current.activate(adaKey) })
    await waitFor(() => expect(result.current.active?.username).toBe("ada"))
  })
})
