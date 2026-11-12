import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { NewerOfflineDataNotice } from "./NewerOfflineDataNotice"
import { Toaster, toast } from "@/components/ui/toast"
import { NewerOfflineDataError } from "@/lib/offline/generation-guard"

let bootError: Error | null = null

vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => ({ store: null, loading: false, error: bootError }),
  OfflineStoreProvider: ({ children }: { children: ReactNode }) => children,
}))

afterEach(() => {
  toast.close()
  bootError = null
})

function renderNotice() {
  render(
    <>
      <Toaster />
      <NewerOfflineDataNotice />
    </>,
  )
}

describe("NewerOfflineDataNotice", () => {
  it("tells the user to update when a newer build owns the offline data", async () => {
    bootError = new NewerOfflineDataError(3, 2)
    renderNotice()
    expect(await screen.findByText(/saved by a newer version of Aquilla/)).toBeInTheDocument()
  })

  it("stays quiet for any other boot failure", async () => {
    bootError = new Error("OPFS unavailable")
    renderNotice()
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })
})
