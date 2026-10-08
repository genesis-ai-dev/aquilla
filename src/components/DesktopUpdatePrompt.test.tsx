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
let storeLoading: boolean
let online: boolean | null
let storeId = 0
let outbox = { count: 0, failed: 0 }
let outboxUnreadable = false
const outboxListeners = new Set<() => void>()

function setOutbox(next: { count: number; failed: number }) {
  outbox = next
  for (const listener of outboxListeners) listener()
}

vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => true }))
vi.mock("@/lib/offline/connectivity", () => ({ useConnectivity: () => online }))
vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => ({ store, loading: storeLoading, error: null }),
  OfflineStoreProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/lib/sync/outbox", () => ({
  readOutboxCounts: async () => {
    if (outboxUnreadable) throw new Error("IndexedDB unavailable")
    return outbox
  },
  subscribeToOutbox: (listener: () => void) => {
    outboxListeners.add(listener)
    return () => outboxListeners.delete(listener)
  },
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
  storeLoading = false
  outbox = { count: 0, failed: 0 }
  outboxUnreadable = false
  outboxListeners.clear()
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
    expect(await screen.findByText(/1 change hasn't reached the server — it was refused/)).toBeInTheDocument()
    // A refused edit isn't retried after the restart, so don't promise it.
    expect(screen.queryByText(/sends after the restart/)).toBeNull()
  })

  it("holds the update while the offline store is still booting", async () => {
    store = null
    storeLoading = true
    const commands = fakeCommands()
    renderPrompt(commands)
    await waitFor(() => expect(commands.download).toHaveBeenCalled())
    await settle()
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it("warns instead of claiming all is sent when the offline store failed to boot", async () => {
    const user = userEvent.setup()
    store = null
    const commands = fakeCommands()
    renderPrompt(commands)

    expect(await screen.findByText(/couldn't check whether all your changes have reached the server/)).toBeInTheDocument()
    expect(screen.queryByText("Aquilla 1.2.0 is ready to install.")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Update anyway" }))
    expect(commands.install).toHaveBeenCalledTimes(1)
  })

  it("holds the update while the IndexedDB outbox still has edits, then offers it once they land", async () => {
    outbox = { count: 1, failed: 0 }
    const commands = fakeCommands()
    renderPrompt(commands)
    await waitFor(() => expect(commands.download).toHaveBeenCalled())
    await settle()
    expect(screen.queryByText(/is ready/)).toBeNull()

    act(() => setOutbox({ count: 0, failed: 0 }))
    expect(await screen.findByText("Aquilla 1.2.0 is ready to install.")).toBeInTheDocument()
  })

  it("counts both queues in the Update anyway warning", async () => {
    store!.commit(queued("q1"))
    outbox = { count: 2, failed: 0 }
    renderPrompt(fakeCommands(), 50)
    expect(await screen.findByText(/3 changes haven't reached the server yet/)).toBeInTheDocument()
  })

  it("says refused changes won't send on their own when the outbox has a failed edit", async () => {
    store!.commit(queued("q1"))
    outbox = { count: 2, failed: 1 }
    renderPrompt(fakeCommands())
    expect(await screen.findByText(/3 changes haven't reached the server, and some were refused/)).toBeInTheDocument()
    expect(screen.queryByText(/send after the restart/)).toBeNull()
  })

  it("warns instead of claiming all is sent when the outbox can't be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    outboxUnreadable = true
    renderPrompt(fakeCommands())

    expect(await screen.findByText(/couldn't check whether all your changes have reached the server/)).toBeInTheDocument()
    expect(screen.queryByText("Aquilla 1.2.0 is ready to install.")).toBeNull()
  })

  it("ignores a second click after the install has started the shutdown", async () => {
    const user = userEvent.setup()
    const commands = fakeCommands()
    renderPrompt(commands)

    const button = await screen.findByRole("button", { name: "Restart to update" })
    await user.click(button)
    await settle()
    await user.click(button)
    expect(commands.install).toHaveBeenCalledTimes(1)
    expect(commands.download).toHaveBeenCalledTimes(1)
  })

  it("ignores a second click while an install is already running", async () => {
    const user = userEvent.setup()
    const commands = fakeCommands()
    commands.install.mockImplementation(() => new Promise<void>(() => {}))
    renderPrompt(commands)

    const button = await screen.findByRole("button", { name: "Restart to update" })
    await user.click(button)
    await user.click(button)
    expect(commands.install).toHaveBeenCalledTimes(1)
  })

  it("closes the toast when an install fails", async () => {
    const user = userEvent.setup()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const commands = fakeCommands()
    commands.install.mockRejectedValue(new Error("no downloaded update to install"))
    // The re-check after the failure finds nothing new.
    commands.download.mockResolvedValueOnce({ version: "1.2.0", notes: null }).mockResolvedValue(null)
    renderPrompt(commands)

    await user.click(await screen.findByRole("button", { name: "Restart to update" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull())
  })
})
