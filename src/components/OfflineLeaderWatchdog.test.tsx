import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { OfflineLeaderWatchdog } from "./OfflineLeaderWatchdog"
import { Toaster, toast } from "@/components/ui/toast"
import { __resetLeaderStalledForTests, isLeaderStalled } from "@/lib/offline/leader-watchdog"
import { __resetOfflineBootProgressForTests, reportOfflineRebuildProgress } from "@/lib/offline/boot-progress"

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
  __resetOfflineBootProgressForTests()
})

const stuck: Status = { isSynced: false, pendingCount: 4, localHead: "e0.14", upstreamHead: "e0.10" }
const synced: Status = { isSynced: true, pendingCount: 0, localHead: "e0.14", upstreamHead: "e0.14" }

// Pending by default, so the toast keeps its first wording.
function renderWatchdog(restart = vi.fn(), rescue = vi.fn(() => new Promise<boolean>(() => {}))) {
  render(
    <>
      <Toaster />
      <OfflineLeaderWatchdog stallMs={40} checkEveryMs={10} restart={restart} rescue={rescue} />
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

  it("rescues unsaved edits on a stall, and says they're safe once that's done", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    status = stuck
    const rescue = vi.fn(() => Promise.resolve(true))
    renderWatchdog(vi.fn(), rescue)

    expect(await screen.findByText(/kept in the upload queue/)).toBeInTheDocument()
    expect(rescue).toHaveBeenCalledTimes(1)
    expect(isLeaderStalled()).toBe(true)
    expect(screen.getByRole("button", { name: /restart app/i })).toBeInTheDocument()
  })

  it("keeps warning that edits may be lost when the rescue fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    status = stuck
    renderWatchdog(vi.fn(), vi.fn(() => Promise.resolve(false)))

    await screen.findByText(/aren't being saved on this device/)
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(screen.queryByText(/kept in the upload queue/)).toBeNull()
  })

  it("retries a failed rescue while the leader stays stalled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    status = stuck
    const rescue = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    render(
      <>
        <Toaster />
        <OfflineLeaderWatchdog stallMs={40} checkEveryMs={10} restart={vi.fn()} rescue={rescue} rescueRetryMs={20} />
      </>,
    )

    expect(await screen.findByText(/kept in the upload queue/)).toBeInTheDocument()
    expect(rescue).toHaveBeenCalledTimes(2)
  })

  it("shows the edits are safe even after the warning was closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    status = stuck
    let finishRescue: (safe: boolean) => void = () => {}
    renderWatchdog(vi.fn(), vi.fn(() => new Promise<boolean>((resolve) => (finishRescue = resolve))))

    await screen.findByText(/aren't being saved on this device/)
    act(() => toast.close("offline-leader-stalled"))
    await waitFor(() => expect(screen.queryByText(/aren't being saved on this device/)).toBeNull())

    await act(async () => finishRescue(true))
    expect(await screen.findByText(/kept in the upload queue/)).toBeInTheDocument()
  })

  it("clears the stall when the watch restarts, so a healthy store isn't bypassed for the session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    status = stuck
    const restart = vi.fn()
    const rescue = vi.fn(() => new Promise<boolean>(() => {}))
    const { rerender } = render(
      <>
        <Toaster />
        <OfflineLeaderWatchdog stallMs={40} checkEveryMs={10} restart={restart} rescue={rescue} />
      </>,
    )
    await waitFor(() => expect(isLeaderStalled()).toBe(true))

    // The leader recovers just as the watch restarts with new settings.
    status = synced
    rerender(
      <>
        <Toaster />
        <OfflineLeaderWatchdog stallMs={50} checkEveryMs={10} restart={restart} rescue={rescue} />
      </>,
    )
    expect(isLeaderStalled()).toBe(false)
    await act(() => new Promise((r) => setTimeout(r, 60)))
    expect(isLeaderStalled()).toBe(false)
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
    const renderBooting = (restart = vi.fn(), slowRebuildMs = 120, hungRebuildMs = 60_000, showRebuildAfterMs = 0) =>
      render(
        <>
          <Toaster />
          <OfflineLeaderWatchdog
            bootStallMs={40}
            showRebuildAfterMs={showRebuildAfterMs}
            slowRebuildMs={slowRebuildMs}
            hungRebuildMs={hungRebuildMs}
            bootCheckEveryMs={10}
            restart={restart}
          />
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

    it("shows rebuild progress instead of a restart prompt while the rebuild moves", async () => {
      booting()
      renderBooting()
      const rehydrate = (done: number) =>
        reportOfflineRebuildProgress({ done, total: 200 })

      rehydrate(50)
      expect(await screen.findByText(/Preparing your offline projects… 25%/)).toBeInTheDocument()
      // Keep it moving for well past bootStallMs.
      for (const done of [80, 110, 140, 170]) {
        await act(() => new Promise((r) => setTimeout(r, 20)))
        rehydrate(done)
      }
      expect(await screen.findByText(/Preparing your offline projects… 85%/)).toBeInTheDocument()
      expect(screen.queryByText(/taking a while to open/)).toBeNull()
      expect(screen.queryByRole("button", { name: /restart app/i })).toBeNull()
    })

    it("doesn't prompt a restart mid-rebuild, and says it's still working once progress stalls", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      booting()
      renderBooting()
      reportOfflineRebuildProgress({ done: 10, total: 200 })
      expect(await screen.findByText(/only takes a moment/)).toBeInTheDocument()

      // Quiet well past both bootStallMs (40 ms) and slowRebuildMs (120 ms).
      expect(await screen.findByText(/taking longer than usual, but it's still working/)).toBeInTheDocument()
      await act(() => new Promise((r) => setTimeout(r, 150)))
      expect(screen.getByText(/Preparing your offline projects… 5%/)).toBeInTheDocument()
      expect(screen.queryByText(/taking a while to open/)).toBeNull()
      expect(screen.queryByRole("button", { name: /restart app/i })).toBeNull()

      // Moving again restores the normal description.
      reportOfflineRebuildProgress({ done: 20, total: 200 })
      expect(await screen.findByText(/only takes a moment/)).toBeInTheDocument()
      expect(screen.getByText(/Preparing your offline projects… 10%/)).toBeInTheDocument()
    })

    it("offers a restart once a rebuild has made no progress for a long time", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      vi.spyOn(console, "error").mockImplementation(() => {})
      const restart = vi.fn()
      booting()
      renderBooting(restart, 60, 120)
      reportOfflineRebuildProgress({ done: 10, total: 200 })
      expect(await screen.findByText(/only takes a moment/)).toBeInTheDocument()

      expect(await screen.findByText(/may be stuck/)).toBeInTheDocument()
      expect(screen.getByText(/Preparing your offline projects… 5%/)).toBeInTheDocument()
      await userEvent.setup().click(screen.getByRole("button", { name: /restart app/i }))
      expect(restart).toHaveBeenCalledOnce()

      // Moving again takes the restart away.
      reportOfflineRebuildProgress({ done: 20, total: 200 })
      expect(await screen.findByText(/only takes a moment/)).toBeInTheDocument()
      await waitFor(() => expect(screen.queryByRole("button", { name: /restart app/i })).toBeNull())
    })

    it("brings the progress toast back with a restart if it was closed before the rebuild hung", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      vi.spyOn(console, "error").mockImplementation(() => {})
      const restart = vi.fn()
      booting()
      renderBooting(restart, 60, 120)
      reportOfflineRebuildProgress({ done: 10, total: 200 })
      const user = userEvent.setup()
      await screen.findByText(/only takes a moment/)
      await user.click(document.querySelector<HTMLElement>(`[data-slot="toast-close"]`)!)
      await waitFor(() => expect(screen.queryByText(/Preparing your offline projects/)).toBeNull())

      expect(await screen.findByText(/may be stuck/)).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: /restart app/i }))
      expect(restart).toHaveBeenCalledOnce()
    })

    it("swaps a restart prompt for progress once a rebuild starts reporting", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      booting()
      renderBooting()
      expect(await screen.findByText(/taking a while to open/)).toBeInTheDocument()

      reportOfflineRebuildProgress({ done: 20, total: 200 })
      expect(await screen.findByText(/Preparing your offline projects… 10%/)).toBeInTheDocument()
      await waitFor(() => expect(screen.queryByText(/taking a while to open/)).toBeNull())
    })

    it("doesn't flash a progress toast for a rebuild that finishes quickly", async () => {
      booting()
      renderBooting(vi.fn(), 120, 60_000, 80)
      reportOfflineRebuildProgress({ done: 50, total: 200 })
      await act(() => new Promise((r) => setTimeout(r, 30)))
      expect(screen.queryByText(/Preparing your offline projects/)).toBeNull()

      reportOfflineRebuildProgress({ done: 200, total: 200 })
      await act(() => new Promise((r) => setTimeout(r, 100)))
      expect(screen.queryByText(/Preparing your offline projects/)).toBeNull()
    })

    it("shows the progress toast once a rebuild has run for a while", async () => {
      booting()
      renderBooting(vi.fn(), 120, 60_000, 50)
      reportOfflineRebuildProgress({ done: 50, total: 200 })
      expect(screen.queryByText(/Preparing your offline projects/)).toBeNull()
      expect(await screen.findByText(/Preparing your offline projects… 25%/)).toBeInTheDocument()
    })

    it("closes the progress toast when the rebuild finishes", async () => {
      booting()
      renderBooting()
      reportOfflineRebuildProgress({ done: 100, total: 200 })
      await screen.findByText(/Preparing your offline projects… 50%/)

      reportOfflineRebuildProgress({ done: 200, total: 200 })
      await waitFor(() => expect(screen.queryByText(/Preparing your offline projects/)).toBeNull())
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
