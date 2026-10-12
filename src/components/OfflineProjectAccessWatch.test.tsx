import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { OfflineProjectAccessWatch } from "./OfflineProjectAccessWatch"
import { Toaster, toast } from "@/components/ui/toast"
import { events, schema, tables } from "@/lib/offline/schema"
import {
  markProjectAvailable,
  markProjectUnavailable,
  resetProjectAccessForTests,
} from "@/lib/offline/project-access"

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
    storeId: `access-watch-test-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
  store.commit(events.projectSynced({ id: "proj1", name: "Genesis Draft", orgId: "org1", settings: null, syncedAt: null }))
  store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "GEN", type: "usfm", sequenceIndex: 0 }))
  store.commit(events.offlineProjectStatusSet({ projectId: "proj1", status: "ready", syncedAt: new Date(), queueDepth: 0 }))
})

afterEach(() => {
  toast.close()
  resetProjectAccessForTests()
})

function queueCommit(id: string): void {
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
}

function renderWatch() {
  render(
    <>
      <Toaster />
      <OfflineProjectAccessWatch />
    </>,
  )
}

describe("OfflineProjectAccessWatch", () => {
  it("shows nothing while every project syncs", async () => {
    renderWatch()
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it("names the project and removes the offline copy on request", async () => {
    const user = userEvent.setup()
    renderWatch()
    act(() => markProjectUnavailable("proj1"))

    expect(await screen.findByText(/“Genesis Draft” is no longer available/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /remove offline copy/i }))

    expect(store.query(tables.offlineProjects.select().where({ projectId: "proj1" }).first())).toBeUndefined()
    await waitFor(() => expect(screen.queryByText(/“Genesis Draft”/)).toBeNull())
  })

  it("warns about unsent edits instead of offering removal", async () => {
    queueCommit("q1")
    queueCommit("q2")
    renderWatch()
    act(() => markProjectUnavailable("proj1"))

    expect(await screen.findByText(/2 changes on this device haven't been sent/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /remove offline copy/i })).toBeNull()
  })

  it("closes the warning when access comes back", async () => {
    renderWatch()
    act(() => markProjectUnavailable("proj1"))
    await screen.findByText(/“Genesis Draft”/)

    act(() => markProjectAvailable("proj1"))
    await waitFor(() => expect(screen.queryByText(/“Genesis Draft”/)).toBeNull())
  })
})
