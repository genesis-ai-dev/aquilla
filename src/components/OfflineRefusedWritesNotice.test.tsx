import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { OfflineRefusedWritesNotice } from "./OfflineRefusedWritesNotice"
import { Toaster, toast } from "@/components/ui/toast"
import { events, schema, tables } from "@/lib/offline/schema"

let store: Store<typeof schema>
let storeId = 0

vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => ({ store, loading: false, error: null }),
  OfflineStoreProvider: ({ children }: { children: ReactNode }) => children,
}))

beforeEach(async () => {
  storeId += 1
  store = await createStorePromise({
    schema,
    storeId: `refused-writes-test-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
})

afterEach(() => {
  toast.close()
})

function queueCommit(id: string, status: "pending" | "failed"): void {
  store.commit(
    events.eventQueued({
      id,
      projectId: "proj1",
      fileId: "file1",
      cellId: "GEN 1:1",
      kind: "target.cell.commit",
      payload: { value: "hola" },
      parentId: "head-1",
      author: "dev@local.test",
      schemaVersion: 1,
      clientTs: new Date(),
      createdAt: new Date(),
    }),
  )
  if (status === "failed") store.commit(events.eventQueueStatusSet({ id, status }))
}

const queue = () =>
  store
    .query(tables.eventQueue.select())
    .map(({ id, status }) => ({ id, status }))
    .sort((a, b) => a.id.localeCompare(b.id))

function renderNotice() {
  render(
    <>
      <Toaster />
      <OfflineRefusedWritesNotice />
    </>,
  )
}

describe("OfflineRefusedWritesNotice", () => {
  it("stays quiet while nothing has been refused", async () => {
    queueCommit("q1", "pending")
    renderNotice()
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it("Retry puts refused edits back in the queue and closes the toast", async () => {
    queueCommit("q1", "failed")
    queueCommit("q2", "failed")
    queueCommit("q3", "pending")
    const user = userEvent.setup()
    renderNotice()

    expect(await screen.findByText(/2 changes you made offline couldn't be saved/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(queue()).toEqual([
      { id: "q1", status: "pending" },
      { id: "q2", status: "pending" },
      { id: "q3", status: "pending" },
    ])
    await waitFor(() => expect(screen.queryByText(/couldn't be saved/)).toBeNull())
  })

  it("Discard asks first, and Keep backs out", async () => {
    queueCommit("q1", "failed")
    const user = userEvent.setup()
    renderNotice()

    await user.click(await screen.findByRole("button", { name: "Discard" }))
    expect(await screen.findByText(/Discard 1 change\? It can't be recovered/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Keep" }))

    expect(await screen.findByText(/1 change you made offline couldn't be saved/)).toBeInTheDocument()
    expect(queue()).toEqual([{ id: "q1", status: "failed" }])
  })

  it("confirmed Discard drops only the refused edits", async () => {
    queueCommit("q1", "failed")
    queueCommit("q2", "pending")
    const user = userEvent.setup()
    renderNotice()

    await user.click(await screen.findByRole("button", { name: "Discard" }))
    await screen.findByText(/Discard 1 change\?/)
    await user.click(screen.getByRole("button", { name: "Discard" }))

    expect(queue()).toEqual([{ id: "q2", status: "pending" }])
    await waitFor(() => expect(screen.queryByText(/Discard 1 change/)).toBeNull())
  })
})
