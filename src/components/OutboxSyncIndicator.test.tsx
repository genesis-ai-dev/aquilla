import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { OutboxSyncIndicator, deriveOutboxChipTone } from "./OutboxSyncIndicator"
import { recordOfflineUpload } from "@/lib/offline/sync-times"
import { __resetLeaderStalledForTests, setLeaderStalled } from "@/lib/offline/leader-watchdog"
import { events, schema } from "@/lib/offline/schema"

let offlineStore: Store<typeof schema> | null = null
let storeSeq = 0

vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => ({ store: offlineStore, loading: false, error: null }),
  OfflineStoreProvider: ({ children }: { children: ReactNode }) => children,
}))

let backendReachable: boolean | null = null
vi.mock("@/lib/offline/connectivity", () => ({ useConnectivity: () => backendReachable }))

afterEach(() => {
  __resetLeaderStalledForTests()
  offlineStore = null
  backendReachable = null
  localStorage.clear()
})

async function offlineStoreWith(rows: { id: string; projectId: string; status: "pending" | "failed" }[]) {
  storeSeq += 1
  const store = await createStorePromise({
    schema,
    storeId: `outbox-chip-test-${storeSeq}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
  for (const { id, projectId, status } of rows) {
    store.commit(
      events.eventQueued({
        id,
        projectId,
        fileId: "file1",
        cellId: "GEN 1:1",
        kind: "target.cell.commit",
        payload: { value: "hola" },
        parentId: null,
        author: "dev@local.test",
        schemaVersion: 1,
        clientTs: new Date(),
        createdAt: new Date(),
      }),
    )
    if (status === "failed") store.commit(events.eventQueueStatusSet({ id, status }))
  }
  return store
}

describe("OutboxSyncIndicator", () => {
  it("shows Synced when the queue is empty", () => {
    render(<OutboxSyncIndicator pendingCount={0} failureStreak={0} />)
    expect(screen.getByRole("button", { name: /all changes synced/i })).toHaveTextContent("Synced")
  })

  it("shows the queued count while writes are pending", () => {
    render(<OutboxSyncIndicator pendingCount={3} failureStreak={0} />)
    expect(screen.getByRole("button")).toHaveTextContent("Queued 3")
  })

  it("never claims Synced while the offline store has stopped saving", () => {
    setLeaderStalled(true)
    render(<OutboxSyncIndicator pendingCount={0} failureStreak={0} />)
    const chip = screen.getByRole("button", { name: /aren't being saved/i })
    expect(chip).toHaveTextContent("Not saving")
    expect(chip).not.toHaveTextContent("Synced")
  })

  it("ranks not-saving above permanently failed writes", () => {
    setLeaderStalled(true)
    render(<OutboxSyncIndicator pendingCount={2} failureStreak={5} failedCount={1} />)
    expect(screen.getByRole("button")).toHaveTextContent("Not saving")
  })

  it("updates live when the stall starts and clears", () => {
    render(<OutboxSyncIndicator pendingCount={0} failureStreak={0} />)
    expect(screen.getByRole("button")).toHaveTextContent("Synced")

    act(() => setLeaderStalled(true))
    expect(screen.getByRole("button")).toHaveTextContent("Not saving")

    act(() => setLeaderStalled(false))
    expect(screen.getByRole("button")).toHaveTextContent("Synced")
  })

  it("counts this project's unsent offline edits as queued (Tauri)", async () => {
    offlineStore = await offlineStoreWith([
      { id: "q1", projectId: "proj1", status: "pending" },
      { id: "q2", projectId: "proj1", status: "pending" },
      { id: "q3", projectId: "other", status: "pending" },
    ])
    render(<OutboxSyncIndicator pendingCount={1} failureStreak={0} projectId="proj1" />)
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("Queued 3"))
  })

  it("never claims Synced while the server has refused offline edits", async () => {
    offlineStore = await offlineStoreWith([{ id: "q1", projectId: "proj1", status: "failed" }])
    render(<OutboxSyncIndicator pendingCount={0} failureStreak={0} projectId="proj1" />)
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("1 failed"))
  })

  it("goes back to Synced once the offline queue drains", async () => {
    const store = await offlineStoreWith([{ id: "q1", projectId: "proj1", status: "failed" }])
    offlineStore = store
    render(<OutboxSyncIndicator pendingCount={0} failureStreak={0} projectId="proj1" />)
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("1 failed"))

    act(() => store.commit(events.eventDequeued({ id: "q1" })))
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("Synced"))
  })

  // Ryder's report: Wi-Fi off, edits went to the offline store, chip still
  // read like a normal upload queue. Offline, it must say the work is only
  // on this device.
  it("says edits are saved on this device, not uploaded, while the backend is unreachable", async () => {
    backendReachable = false
    offlineStore = await offlineStoreWith([
      { id: "q1", projectId: "proj1", status: "pending" },
      { id: "q2", projectId: "proj1", status: "pending" },
    ])
    render(<OutboxSyncIndicator pendingCount={0} failureStreak={0} projectId="proj1" />)
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("On device · 2"))
    expect(screen.getByRole("button", { name: /saved on this device, 2 changes not uploaded/i })).toBeInTheDocument()
  })

  it("shows last upload and download times for a downloaded project", async () => {
    const store = await offlineStoreWith([])
    store.commit(
      events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
    offlineStore = store
    render(<OutboxSyncIndicator pendingCount={0} failureStreak={0} projectId="proj1" />)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /last upload: never\. last download: now/i })).toBeInTheDocument(),
    )
    act(() => recordOfflineUpload("proj1"))
    expect(screen.getByRole("button", { name: /last upload: now\./i })).toBeInTheDocument()
  })
})

describe("deriveOutboxChipTone", () => {
  const base = { leaderStalled: false, failed: 0, failureStreak: 0, pending: 0, offlinePending: 0, online: true }

  it("calls offline-store edits 'saved locally' only when the backend is known unreachable", () => {
    expect(deriveOutboxChipTone({ ...base, pending: 2, offlinePending: 2, online: false })).toBe("savedLocally")
    // Reachable: they are uploading, so plain "queued".
    expect(deriveOutboxChipTone({ ...base, pending: 2, offlinePending: 2, online: true })).toBe("queued")
    // Unknown (web build / before first probe): don't assert offline.
    expect(deriveOutboxChipTone({ ...base, pending: 2, offlinePending: 2, online: null })).toBe("queued")
  })

  it("does not call IndexedDB outbox rows 'saved on this device'", () => {
    expect(deriveOutboxChipTone({ ...base, pending: 2, offlinePending: 0, online: false })).toBe("queued")
  })

  it("keeps refused writes and a stalled store above the offline state", () => {
    expect(deriveOutboxChipTone({ ...base, failed: 1, offlinePending: 2, online: false })).toBe("warning")
    expect(deriveOutboxChipTone({ ...base, leaderStalled: true, offlinePending: 2, online: false })).toBe("notSaving")
  })
})
