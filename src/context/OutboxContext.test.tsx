import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { OutboxProvider } from "./OutboxContext"
import type { SyncTokenCallbacks } from "@/lib/sync/sync-token"
import { addSession, clearSession, listSessions, saveSession } from "@/lib/frontier/session-store"
import { clearSessionExpired, onSessionExpired } from "@/lib/errors/session-expired-signal"
import type { OutboxFlushTarget, UseOutboxFlusherOptions } from "@/hooks/useOutboxFlusher"

let callbacks: SyncTokenCallbacks | null = null
let flusherOptions: UseOutboxFlusherOptions | null = null

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt-active", username: "alice", createdAt: "x" },
    loading: false,
  }),
}))
vi.mock("@/lib/sync/cqrs-bridge", () => ({
  buildProjectAwareMinter: (
    getJwt: () => string | null,
    _apiUrl: string | undefined,
    nextCallbacks: SyncTokenCallbacks,
  ) => {
    callbacks = nextCallbacks
    return vi.fn(async () => ({ token: `sync-for-${getJwt()}`, status: 200 }))
  },
}))
vi.mock("@/hooks/useOutboxFlusher", () => ({
  useOutboxFlusher: (options: UseOutboxFlusherOptions) => {
    flusherOptions = options
    return {
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
    }
  },
}))
vi.mock("@/hooks/usePendingOutboxRecords", () => ({
  usePendingOutboxRecords: () => [],
}))

beforeEach(async () => {
  callbacks = null
  flusherOptions = null
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

  it("builds one exact-JWT flush target for every stored account", async () => {
    render(<OutboxProvider><span>child</span></OutboxProvider>)

    let targets: OutboxFlushTarget[] = []
    await act(async () => {
      targets = await flusherOptions!.getFlushTargets!()
    })
    expect(targets.map((target) => target.ownerKey).sort()).toEqual(["alice", "bob"])

    const alice = targets.find((target) => target.ownerKey === "alice")!
    const bob = targets.find((target) => target.ownerKey === "bob")!
    expect(await alice.getTokenForFile("project", "file")).toEqual({
      token: "sync-for-jwt-active",
      status: 200,
    })
    expect(await bob.getTokenForFile("project", "file")).toEqual({
      token: "sync-for-jwt-other",
      status: 200,
    })
    expect(alice.shouldSurface()).toBe(true)
    expect(bob.shouldSurface()).toBe(false)

    await addSession({ jwt: "jwt-other-rotated", username: "bob", createdAt: "z" })
    expect(await bob.isSessionCurrent()).toBe(false)
    const refreshed = await flusherOptions!.getFlushTargets!()
    const refreshedBob = refreshed.find((target) => target.ownerKey === "bob")!
    expect(await refreshedBob.isSessionCurrent()).toBe(true)
    expect(await refreshedBob.getTokenForFile("project", "file")).toEqual({
      token: "sync-for-jwt-other-rotated",
      status: 200,
    })
  })
})
