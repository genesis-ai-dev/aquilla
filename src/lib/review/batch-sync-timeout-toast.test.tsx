import { afterEach, describe, expect, it } from "vitest"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Toaster, toast } from "@/components/ui/toast"
import { showBatchSyncTimeoutToast } from "./batch-sync-timeout-toast"

function toastRoot(title: string): HTMLElement | null {
  return screen.queryByText(title)?.closest("[data-slot='toast']") ?? null
}

function hasLeft(title: string): boolean {
  const root = toastRoot(title)
  return root === null || root.hasAttribute("data-ending-style")
}

afterEach(() => {
  toast.close()
})

describe("showBatchSyncTimeoutToast", () => {
  it("stays up until the reader closes it", async () => {
    render(<Toaster />)
    const user = userEvent.setup()

    act(() => {
      toast.add({ type: "error", title: "Saved" })
      showBatchSyncTimeoutToast("Fresh", null)
      const waitingId = toast.add({
        type: "loading",
        title: "Waiting for sync to complete.",
        timeout: 0,
      })
      showBatchSyncTimeoutToast("Updated", waitingId)
    })

    // A plain error toast uses the five-second default. These two do not.
    await waitFor(() => {
      expect(hasLeft("Saved")).toBe(true)
    }, { timeout: 8_000 })
    expect(hasLeft("Fresh")).toBe(false)
    expect(hasLeft("Updated")).toBe(false)

    const updated = toastRoot("Updated")
    expect(updated).not.toBeNull()
    await user.click(within(updated as HTMLElement).getByRole("button", { name: "Close notification" }))
    await waitFor(() => {
      expect(hasLeft("Updated")).toBe(true)
    })
    expect(hasLeft("Fresh")).toBe(false)
  }, 15_000)
})
