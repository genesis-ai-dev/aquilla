import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Toaster, toast } from "@/components/ui/toast"
import { events, schema } from "@/lib/offline/schema"
import { DesktopUpdatePrompt, type DesktopUpdateCommands } from "./DesktopUpdatePrompt"

let store: Store<typeof schema> | null
let online: boolean | null
let storeId = 0

vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => true }))
vi.mock("@/lib/offline/connectivity", () => ({ useConnectivity: () => online }))
vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => ({ store, loading: false, error: null }),
  OfflineStoreProvider: ({ children }: { children: ReactNode }) => children,
}))

const queued = (id: string) =>
  events.eventQueued({
    id,
    projectId: "proj1",
    fileId: "file1",
    cellId: "GEN 1:1",
    kind: "target.cell.commit",
    payload: { text: "En el principio" },
    parentId: null,
    author: "dev@local.test",
    schemaVersion: 1,
    clientTs: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
  })

beforeEach(async () => {
  storeId += 1
  online = true
  store = await createStorePromise({
    schema,
    storeId: `update-prompt-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
})

afterEach(() => {
  toast.close()
  vi.restoreAllMocks()
})

function fakeCommands(version: string | null = "1.2.0"): DesktopUpdateCommands & {
  download: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
} {
  return {
    download: vi.fn(async () => (version ? { version, notes: null } : null)),
    install: vi.fn(async () => {}),
  }
}

function renderPrompt(commands: DesktopUpdateCommands, graceMs = 60_000) {
  return render(
    <>
      <Toaster />
      <DesktopUpdatePrompt commands={commands} graceMs={graceMs} />
    </>,
  )
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)))

describe("DesktopUpdatePrompt", () => {
  it("does not check for updates while offline", async () => {
    online = false
    const commands = fakeCommands()
    renderPrompt(commands)
    await settle()
    expect(commands.download).not.toHaveBeenCalled()
  })

  it("shows nothing when the app is up to date", async () => {
    const commands = fakeCommands(null)
    renderPrompt(commands)
    await waitFor(() => expect(commands.download).toHaveBeenCalled())
    await settle()
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it("offers the update straight away when nothing is queued", async () => {
    const user = userEvent.setup()
    const commands = fakeCommands()
    renderPrompt(commands)

    expect(await screen.findByText("Aquilla 1.2.0 is ready to install.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Restart to update" }))
    expect(commands.install).toHaveBeenCalledTimes(1)
  })

  it("holds the update while offline edits are still sending, then offers it once they land", async () => {
    store!.commit(queued("q1"))
    const commands = fakeCommands()
    renderPrompt(commands)
    await waitFor(() => expect(commands.download).toHaveBeenCalled())
    await settle()
    expect(screen.queryByText(/is ready/)).toBeNull()

    act(() => store!.commit(events.eventDequeued({ id: "q1" })))
    expect(await screen.findByText("Aquilla 1.2.0 is ready to install.")).toBeInTheDocument()
    expect(commands.install).not.toHaveBeenCalled()
  })

  it("withdraws a shown offer when a new edit is queued", async () => {
    const commands = fakeCommands()
    renderPrompt(commands)
    expect(await screen.findByText("Aquilla 1.2.0 is ready to install.")).toBeInTheDocument()

    act(() => store!.commit(queued("q1")))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull())
  })

  it("offers Update anyway when the queue doesn't drain within the grace period", async () => {
    const user = userEvent.setup()
    store!.commit(queued("q1"), queued("q2"))
    const commands = fakeCommands()
    renderPrompt(commands, 50)

    expect(await screen.findByText(/2 changes haven't reached the server yet/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Update anyway" }))
    expect(commands.install).toHaveBeenCalledTimes(1)
  })

  it("offers Update anyway at once when a queued edit has failed", async () => {
    store!.commit(queued("q1"))
    store!.commit(events.eventQueueStatusSet({ id: "q1", status: "failed" }))
    renderPrompt(fakeCommands())
    expect(await screen.findByText(/1 change hasn't reached the server yet/)).toBeInTheDocument()
  })

  it("offers the update when the offline store never booted", async () => {
    store = null
    renderPrompt(fakeCommands())
    expect(await screen.findByText("Aquilla 1.2.0 is ready to install.")).toBeInTheDocument()
  })
})
