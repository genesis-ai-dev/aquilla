import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, renderHook, act, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { AccountsProvider, useAccounts } from "./useAccounts"
import * as sessionStore from "@/lib/frontier/session-store"
import {
  _resetDbForTesting, addSession, sessionKey,
} from "@/lib/frontier/session-store"

// useAccounts clears the React Query cache on account switch (AQU-212), so it
// needs a QueryClientProvider — same as the app root in main.tsx.
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
)

describe("useAccounts", () => {
  beforeEach(async () => { await _resetDbForTesting() })

  it("returns empty state initially", async () => {
    const { result } = renderHook(() => useAccounts(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.active).toBeNull()
    expect(result.current.sessions).toHaveLength(0)
  })

  it("hydrates IndexedDB once for multiple app-level consumers", async () => {
    const loadActiveSpy = vi.spyOn(sessionStore, "loadActiveSession")
    const listSessionsSpy = vi.spyOn(sessionStore, "listSessions")
    const qc = new QueryClient()

    function Consumer() {
      const { loading } = useAccounts()
      return <span>{loading ? "loading" : "ready"}</span>
    }

    const view = render(
      <QueryClientProvider client={qc}>
        <AccountsProvider>
          <Consumer />
          <Consumer />
        </AccountsProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(view.getAllByText("ready")).toHaveLength(2)
    })
    expect(loadActiveSpy).toHaveBeenCalledTimes(1)
    expect(listSessionsSpy).toHaveBeenCalledTimes(1)
  })

  it("reflects sessions after add", async () => {
    await addSession({
      jwt: "x",
      username: "ada", createdAt: "2026-01-01T00:00:00Z",
    })
    const { result } = renderHook(() => useAccounts(), { wrapper })
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.active?.username).toBe("ada")
  })

  it("activate swaps active session", async () => {
    await addSession({
      jwt: "x",
      username: "ryder", createdAt: "2026-01-01T00:00:00Z",
    })
    await addSession({
      jwt: "y",
      username: "ada", createdAt: "2026-01-02T00:00:00Z",
    })
    const { result } = renderHook(() => useAccounts(), { wrapper })
    await waitFor(() => expect(result.current.sessions).toHaveLength(2))
    const adaKey = sessionKey({
      jwt: "y",
      username: "ada", createdAt: "2026-01-02T00:00:00Z",
    })
    await act(async () => { await result.current.activate(adaKey) })
    await waitFor(() => expect(result.current.active?.username).toBe("ada"))
  })

  // FRO-367: when a refresh observes a DIFFERENT active account than before —
  // e.g. another tab switched accounts and pinged this one — the tab must drop
  // its React Query cache so no prior-account data survives the switch.
  it("clears the query cache when the active account changes under it, but not on first load", async () => {
    const qc = new QueryClient()
    const clearSpy = vi.spyOn(qc, "clear")
    const scopedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    await addSession({ jwt: "a", username: "alice", createdAt: "2026-01-01T00:00:00Z" })

    const { result } = renderHook(() => useAccounts(), { wrapper: scopedWrapper })
    await waitFor(() => expect(result.current.active?.username).toBe("alice"))
    // First load establishes the baseline key — no clear.
    expect(clearSpy).not.toHaveBeenCalled()

    // Simulate a cross-tab switch landing in this tab: add + activate bob, then
    // drive the subscribeSession notify the ping would trigger.
    const store = await import("@/lib/frontier/session-store")
    await act(async () => {
      await store.addSession({ jwt: "b", username: "bob", createdAt: "2026-01-02T00:00:00Z" })
      await store.activateSession("bob")
    })
    await waitFor(() => expect(result.current.active?.username).toBe("bob"))
    expect(clearSpy).toHaveBeenCalled()
  })

  // A session write after first load must revalidate SILENTLY. Re-entering
  // `loading` sends pages that gate on it (OrgHome's LoadingOverlay) back to
  // their skeleton mid-interaction, unmounting the sidebar — and with it the
  // open account menu, whose `open` is local state. That is how the email
  // backfill closed the dropdown it had just been opened to populate.
  it("does not re-enter loading when a session write revalidates it", async () => {
    const alice = { jwt: "a", username: "alice", createdAt: "2026-01-01T00:00:00Z" }
    await addSession(alice)

    // Record what every render actually saw. Asserting on the settled value
    // would pass even while the bug was present, because the transient
    // `loading: true` render is gone again by the time the act() flush ends.
    const renderedLoading: boolean[] = []
    function Probe() {
      const { loading, sessions } = useAccounts()
      renderedLoading.push(loading)
      // Project loading into the DOM so the waits below key off the settled
      // state rather than an email that is also absent mid-load.
      return <span>{loading ? "loading" : `ready:${sessions[0]?.email ?? "none"}`}</span>
    }

    const view = render(
      <QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>,
    )
    await waitFor(() => expect(view.getByText("ready:none")).toBeTruthy())
    renderedLoading.length = 0

    const store = await import("@/lib/frontier/session-store")
    await act(async () => {
      await store.patchSessionEmails({ [sessionKey(alice)]: "alice@example.com" })
    })

    await waitFor(() => expect(view.getByText("ready:alice@example.com")).toBeTruthy())
    expect(renderedLoading).not.toContain(true)
  })
})
