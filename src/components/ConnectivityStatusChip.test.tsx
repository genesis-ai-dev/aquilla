import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { ConnectivityStatusChip } from "./ConnectivityStatusChip"

let tauriRuntime = false
vi.mock("@/lib/offline/is-tauri", () => ({
  isTauriRuntime: () => tauriRuntime,
}))

let connectivity: boolean | null = null
vi.mock("@/lib/offline/connectivity", () => ({
  useConnectivity: () => connectivity,
}))

function renderChip() {
  return render(<ConnectivityStatusChip />)
}

beforeEach(() => {
  tauriRuntime = false
  connectivity = null
})

describe("ConnectivityStatusChip", () => {
  it("renders nothing outside Tauri", () => {
    tauriRuntime = false
    connectivity = true
    renderChip()
    expect(screen.queryByTestId("connectivity-status-chip")).toBeNull()
  })

  it("renders nothing before the first connectivity check resolves", () => {
    tauriRuntime = true
    connectivity = null
    renderChip()
    expect(screen.queryByTestId("connectivity-status-chip")).toBeNull()
  })

  it("shows an online chip when connected", () => {
    tauriRuntime = true
    connectivity = true
    renderChip()
    const chip = screen.getByTestId("connectivity-status-chip")
    expect(chip).toHaveAttribute("data-online", "true")
  })

  it("shows an offline chip when disconnected", () => {
    tauriRuntime = true
    connectivity = false
    renderChip()
    const chip = screen.getByTestId("connectivity-status-chip")
    expect(chip).toHaveAttribute("data-online", "false")
  })
})
