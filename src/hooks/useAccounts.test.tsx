import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, renderHook, act, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { AccountsProvider, SESSION_LOAD_TIMEOUT_MS, useAccounts } from "./useAccounts"
import * as sessionStore from "@/lib/frontier/session-store"
import * as projectIndex from "@/lib/store/project-index"
import {
  _resetDbForTesting, addSession, sessionKey,
  publishDataOwner, saveSession,
} from "@/lib/frontier/session-store"

// useAccounts clears the React Query cache on account switch (AQU-212), so it
// needs a QueryClientProvider — same as the app root in main.tsx.
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
)

describe("useAccounts", () => {
  beforeEach(async () => {
    await _resetDbForTesting()
    await projectIndex.clearAllLocalData()
  })
  afterEach(() => vi.restoreAllMocks())

  it("returns empty state initially", async () => {
    const { result } = renderHook(() => useAccounts(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hydrated).toBe(true)
    expect(result.current.active).toBeNull()
    expect(result.current.sessions).toHaveLength(0)
  })

  it("hydrates IndexedDB once for multiple app-level consumers", async () => {
    const snapshotSpy = vi.spyOn(sessionStore, "loadAccountsSnapshot")
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
    expect(snapshotSpy).toHaveBeenCalledTimes(1)
  })

  it("surfaces a recoverable error when session storage hangs, then retries", async () => {
    vi.useFakeTimers()
    const snapshotSpy = vi.spyOn(sessionStore, "loadAccountsSnapshot")
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ active: null, sessions: [], dataOwner: null })
    try {
      const { result } = renderHook(() => useAccounts(), { wrapper })
      await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_LOAD_TIMEOUT_MS) })

      expect(result.current.loading).toBe(false)
      expect(result.current.loadError?.message).toMatch(/did not respond/i)

      const callsBeforeRetry = snapshotSpy.mock.calls.length
      // The retry now durably publishes the resolved data owner through IDB;
      // fake-indexeddb schedules that transaction with timers, so restore real
      // timers after exercising the hydration timeout itself.
      vi.useRealTimers()
      await act(async () => { await result.current.retryLoad() })
      expect(result.current.loadError).toBeNull()
      expect(snapshotSpy).toHaveBeenCalledTimes(callsBeforeRetry + 1)
    } finally {
      vi.useRealTimers()
    }
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

  it("keeps the previous identity behind a loading boundary until cleanup settles", async () => {
    const alice = { jwt: "a", username: "alice", createdAt: "2026-01-01T00:00:00Z" }
    const bob = { jwt: "b", username: "bob", createdAt: "2026-01-02T00:00:00Z" }
    await addSession(alice)
    const qc = new QueryClient()
    const scopedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useAccounts(), { wrapper: scopedWrapper })
    await waitFor(() => expect(result.current.active?.username).toBe("alice"))

    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const cleanupSpy = vi.spyOn(projectIndex, "clearAllLocalData").mockReturnValueOnce(cleanup)
    // `adopt` follows an auth helper that has already persisted the session.
    // This focused state-ordering test supplies that durable commit boundary.
    vi.spyOn(sessionStore, "publishDataOwner").mockResolvedValue(true)
    let adopting!: Promise<void>
    act(() => { adopting = result.current.adopt(bob) })

    expect(result.current.active?.username).toBe("alice")
    expect(result.current.loading).toBe(true)
    expect(result.current.hydrated).toBe(true)
    expect(cleanupSpy).toHaveBeenCalledOnce()

    releaseCleanup()
    await act(async () => { await adopting })
    expect(result.current.active?.username).toBe("bob")
    expect(result.current.loading).toBe(false)
  })

  it("blocks the account handoff and exposes retry when cleanup fails", async () => {
    const alice = { jwt: "a", username: "alice", createdAt: "2026-01-01T00:00:00Z" }
    const bob = { jwt: "b", username: "bob", createdAt: "2026-01-02T00:00:00Z" }
    await addSession(alice)
    const { result } = renderHook(() => useAccounts(), { wrapper })
    await waitFor(() => expect(result.current.active?.username).toBe("alice"))

    vi.spyOn(projectIndex, "clearAllLocalData")
      .mockRejectedValueOnce(new Error("blocked database"))
      .mockResolvedValueOnce(undefined)
    vi.spyOn(sessionStore, "publishDataOwner").mockResolvedValue(true)

    await act(async () => {
      await expect(result.current.adopt(bob)).rejects.toThrow(/blocked database/i)
    })
    expect(result.current.active?.username).toBe("alice")
    expect(result.current.loading).toBe(false)
    expect(result.current.transitionError?.message).toMatch(/blocked database/i)

    vi.spyOn(sessionStore, "loadAccountsSnapshot").mockResolvedValueOnce({
      active: bob,
      dataOwner: "alice",
      sessions: [{
        key: "bob",
        username: "bob",
        createdAt: bob.createdAt,
        active: true,
      }],
    })
    await act(async () => { await result.current.retryTransition() })
    expect(result.current.active?.username).toBe("bob")
    expect(result.current.transitionError).toBeNull()
  })

  it("resumes cleanup after a reload interrupts a persisted account switch", async () => {
    const alice = { jwt: "a", username: "alice", createdAt: "2026-01-01T00:00:00Z" }
    const bob = { jwt: "b", username: "bob", createdAt: "2026-01-02T00:00:00Z" }
    await saveSession(alice)
    await publishDataOwner("alice")
    // Session activation landed, but the old tab closed before publishing the
    // matching client-data owner.
    await saveSession(bob)
    const cleanupSpy = vi.spyOn(projectIndex, "clearAllLocalData")

    const { result } = renderHook(() => useAccounts(), { wrapper })
    await waitFor(() => expect(result.current.active?.username).toBe("bob"))

    expect(cleanupSpy).toHaveBeenCalledOnce()
    expect((await sessionStore.loadAccountsSnapshot()).dataOwner).toBe("bob")
  })

  it("resumes cleanup after a reload interrupts logout", async () => {
    const alice = { jwt: "a", username: "alice", createdAt: "2026-01-01T00:00:00Z" }
    await saveSession(alice)
    await publishDataOwner("alice")
    await sessionStore.clearSession()
    const cleanupSpy = vi.spyOn(projectIndex, "clearAllLocalData")

    const { result } = renderHook(() => useAccounts(), { wrapper })
    await waitFor(() => expect(result.current.hydrated).toBe(true))

    expect(result.current.active).toBeNull()
    expect(cleanupSpy).toHaveBeenCalledOnce()
    expect((await sessionStore.loadAccountsSnapshot()).dataOwner).toBeNull()
  })

  it("preserves local-only projects on the first account login", async () => {
    await projectIndex.createProject({
      id: "local-project",
      name: "Local project",
      sourceLanguage: "en",
      targetLanguage: "fr",
      createdAt: "2026-01-01T00:00:00Z",
      files: [],
      members: [],
    })
    const cleanupSpy = vi.spyOn(projectIndex, "clearAllLocalData")
    const { result } = renderHook(() => useAccounts(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    vi.spyOn(sessionStore, "publishDataOwner").mockResolvedValue(true)

    await act(async () => {
      await result.current.adopt({
        jwt: "b",
        username: "bob",
        createdAt: "2026-01-02T00:00:00Z",
      })
    })

    expect(cleanupSpy).not.toHaveBeenCalled()
    expect(result.current.active?.username).toBe("bob")
    expect(await projectIndex.getProject("local-project")).toBeDefined()
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
