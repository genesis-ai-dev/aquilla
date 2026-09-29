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

vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => ({ store: fakeStore, loading: false, error: null }),
  OfflineStoreProvider: ({ children }: { children: ReactNode }) => children,
}))

afterEach(() => {
  toast.close()
  vi.restoreAllMocks()
  __resetLeaderStalledForTests()
})

const stuck: Status = { isSynced: false, pendingCount: 4, localHead: "e0.14", upstreamHead: "e0.10" }
const synced: Status = { isSynced: true, pendingCount: 0, localHead: "e0.14", upstreamHead: "e0.14" }

function renderWatchdog(reload = vi.fn()) {
  render(
    <>
      <Toaster />
      <OfflineLeaderWatchdog stallMs={40} checkEveryMs={10} reload={reload} />
    </>,
  )
  return reload
}

describe("OfflineLeaderWatchdog", () => {
  it("shows nothing while the store keeps up", async () => {
    status = synced
    renderWatchdog()
    await act(() => new Promise((r) => setTimeout(r, 120)))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it("warns once writes stop persisting, and Reload calls reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    status = stuck
    const user = userEvent.setup()
    const reload = renderWatchdog()

    expect(await screen.findByText(/aren't being saved on this device/)).toBeInTheDocument()
    expect(console.error).toHaveBeenCalledWith(
      "[offline] LiveStore leader stopped persisting writes",
      expect.objectContaining({ pendingCount: 4, upstreamHead: "e0.10" }),
    )

    await user.click(screen.getByRole("button", { name: /reload/i }))
    expect(reload).toHaveBeenCalledTimes(1)
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
})
