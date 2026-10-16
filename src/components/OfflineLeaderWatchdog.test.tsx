import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { OfflineLeaderWatchdog } from "./OfflineLeaderWatchdog"
import { Toaster, toast } from "@/components/ui/toast"
import { __resetLeaderStalledForTests, isLeaderStalled } from "@/lib/offline/leader-watchdog"

type Status = { isSynced: boolean; pendingCount: number; localHead: string; upstreamHead: string }

let status: Status
const fakeStore = { syncStatus: () => status }
let offlineStore: { store: typeof fakeStore | null; loading: boolean; error: null } = {
  store: fakeStore,
  loading: false,
  error: null,
}

vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => offlineStore,
  OfflineStoreProvider: ({ children }: { children: ReactNode }) => children,
}))

afterEach(() => {
  offlineStore = { store: fakeStore, loading: false, error: null }
  toast.close()
  vi.restoreAllMocks()
  __resetLeaderStalledForTests()
})

const stuck: Status = { isSynced: false, pendingCount: 4, localHead: "e0.14", upstreamHead: "e0.10" }
const synced: Status = { isSynced: true, pendingCount: 0, localHead: "e0.14", upstreamHead: "e0.14" }

function renderWatchdog(restart = vi.fn()) {
  render(
    <>
      <Toaster />
      <OfflineLeaderWatchdog stallMs={40} checkEveryMs={10} restart={restart} />
    </>,
  )
  return restart
}

describe("OfflineLeaderWatchdog", () => {
  it("shows nothing while the store keeps up", async () => {
    status = synced
    renderWatchdog()
    await act(() => new Promise((r) => setTimeout(r, 120)))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it("warns once writes stop persisting, and Restart app calls restart", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    status = stuck
    const user = userEvent.setup()
    const restart = renderWatchdog()

    expect(await screen.findByText(/aren't being saved on this device/)).toBeInTheDocument()
    expect(console.error).toHaveBeenCalledWith(
      "[offline] LiveStore leader stopped persisting writes",
      expect.objectContaining({ pendingCount: 4, upstreamHead: "e0.10" }),
    )

    await user.click(screen.getByRole("button", { name: /restart app/i }))
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it("closes the warning if the leader catches up on its own", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    status = stuck
    renderWatchdog()
    await screen.findByText(/aren't being saved on this device/)
    expect(isLeaderStalled()).toBe(true)

    status = synced
    await waitFor(() => expect(document.querySelector('[data-slot="toast"]')).toBeNull())
    expect(isLeaderStalled()).toBe(false)
  })

  describe("while the store hasn't booted", () => {
    const booting = () => {
      offlineStore = { store: null, loading: true, error: null }
    }
    const renderBooting = (restart = vi.fn()) =>
      render(
        <>
          <Toaster />
          <OfflineLeaderWatchdog bootStallMs={40} restart={restart} />
        </>,
      )

    it("prompts a restart once boot has taken too long", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      booting()
      const user = userEvent.setup()
      const restart = vi.fn()
      renderBooting(restart)

      expect(await screen.findByText(/taking a while to open/)).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: /restart app/i }))
      expect(restart).toHaveBeenCalledTimes(1)
    })

    it("closes the prompt once the store boots", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      booting()
      const { rerender } = renderBooting()
      await screen.findByText(/taking a while to open/)

      offlineStore = { store: fakeStore, loading: false, error: null }
      status = synced
      rerender(
        <>
          <Toaster />
          <OfflineLeaderWatchdog bootStallMs={40} />
        </>,
      )
      await waitFor(() => expect(document.querySelector('[data-slot="toast"]')).toBeNull())
    })

    it("stays quiet for a boot that finishes in time", async () => {
      booting()
      const { rerender } = renderBooting()
      offlineStore = { store: fakeStore, loading: false, error: null }
      status = synced
      rerender(
        <>
          <Toaster />
          <OfflineLeaderWatchdog bootStallMs={40} />
        </>,
      )
      await act(() => new Promise((r) => setTimeout(r, 120)))
      expect(document.querySelector('[data-slot="toast"]')).toBeNull()
    })
  })
})
