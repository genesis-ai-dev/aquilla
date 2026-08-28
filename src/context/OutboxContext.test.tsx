import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { OutboxProvider } from "./OutboxContext"
import type { SyncTokenCallbacks } from "@/lib/sync/sync-token"
import { addSession, clearSession, listSessions, saveSession } from "@/lib/frontier/session-store"
import { clearSessionExpired, onSessionExpired } from "@/lib/errors/session-expired-signal"

let callbacks: SyncTokenCallbacks | null = null

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt-active", username: "alice", createdAt: "x" },
    loading: false,
  }),
}))
vi.mock("@/lib/sync/cqrs-bridge", () => ({
  buildProjectAwareMinter: (
    _getJwt: () => string | null,
    _apiUrl: string | undefined,
    nextCallbacks: SyncTokenCallbacks,
  ) => {
    callbacks = nextCallbacks
    return vi.fn(async () => ({ token: null, status: 401 }))
  },
}))
vi.mock("@/hooks/useOutboxFlusher", () => ({
  useOutboxFlusher: () => ({
    pendingCount: 0,
    failedCount: 0,
    failureStreak: 0,
    flushNow: vi.fn(),
    refreshPending: vi.fn(async () => 0),
    staleSiblingCount: 0,
    staleSiblingEntries: [],
    clearStaleSiblings: vi.fn(),
    staleSourceCount: 0,
    clearStaleSource: vi.fn(),
  }),
}))
vi.mock("@/hooks/usePendingOutboxRecords", () => ({
  usePendingOutboxRecords: () => [],
}))

beforeEach(async () => {
  callbacks = null
  clearSessionExpired()
  await clearSession()
  await addSession({ jwt: "jwt-other", username: "bob", createdAt: "w" })
  await saveSession({ jwt: "jwt-active", username: "alice", createdAt: "x" })
})

describe("OutboxProvider unauthorized session handling", () => {
  it("requests scoped re-auth without deleting the active or other account", async () => {
    const expired = vi.fn()
    const unsubscribe = onSessionExpired(expired)
    render(<OutboxProvider><span>child</span></OutboxProvider>)
    expect(screen.getByText("child")).toBeInTheDocument()

    await act(async () => {
      callbacks?.onUnauthorized?.("jwt-active")
    })

    await waitFor(() => expect(expired).toHaveBeenCalledWith("jwt-active"))
    expect((await listSessions()).map((session) => session.username).sort()).toEqual(["alice", "bob"])
    unsubscribe()
  })
})
