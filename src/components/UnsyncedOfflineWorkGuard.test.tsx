import { describe, it, expect, vi, beforeEach } from "vitest"
import { render } from "@testing-library/react"
import { UnsyncedOfflineWorkGuard } from "./UnsyncedOfflineWorkGuard"

let mockStore: object | null = null
vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => ({ store: mockStore, loading: false, error: null }),
}))

const useUnsyncedOfflineWorkGuard = vi.fn()
vi.mock("@/lib/offline/unsynced-guard", () => ({
  useUnsyncedOfflineWorkGuard: (store: unknown) => useUnsyncedOfflineWorkGuard(store),
}))

beforeEach(() => {
  mockStore = null
  useUnsyncedOfflineWorkGuard.mockClear()
})

describe("UnsyncedOfflineWorkGuard", () => {
  it("renders nothing and forwards the current store to the guard hook", () => {
    mockStore = { id: "fake-store" }
    const { container } = render(<UnsyncedOfflineWorkGuard />)
    expect(container).toBeEmptyDOMElement()
    expect(useUnsyncedOfflineWorkGuard).toHaveBeenCalledWith(mockStore)
  })

  it("forwards null outside Tauri / before the store boots", () => {
    render(<UnsyncedOfflineWorkGuard />)
    expect(useUnsyncedOfflineWorkGuard).toHaveBeenCalledWith(null)
  })
})
