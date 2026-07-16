// AQU-296: OfflineBanner component tests.

import { describe, it, expect, afterEach } from "vitest"
import { render, screen, act } from "@testing-library/react"
import { OfflineBanner } from "./OfflineBanner"

// Helper to simulate browser online/offline events.
function goOffline() {
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true })
  window.dispatchEvent(new Event("offline"))
}

function goOnline() {
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true })
  window.dispatchEvent(new Event("online"))
}

afterEach(() => {
  // Reset to online so tests don't bleed into each other.
  goOnline()
})

describe("OfflineBanner", () => {
  it("renders nothing when online", () => {
    goOnline()
    render(<OfflineBanner />)
    expect(screen.queryByTestId("offline-banner")).toBeNull()
  })

  it("renders the banner when offline at mount", () => {
    goOffline()
    render(<OfflineBanner />)
    expect(screen.getByTestId("offline-banner")).toBeDefined()
    expect(screen.getByText(/you're offline/i)).toBeDefined()
  })

  it("shows banner when browser goes offline after mount", () => {
    goOnline()
    render(<OfflineBanner />)
    expect(screen.queryByTestId("offline-banner")).toBeNull()

    act(() => { goOffline() })
    expect(screen.getByTestId("offline-banner")).toBeDefined()
  })

  it("hides banner when browser comes back online", () => {
    goOffline()
    render(<OfflineBanner />)
    expect(screen.getByTestId("offline-banner")).toBeDefined()

    act(() => { goOnline() })
    expect(screen.queryByTestId("offline-banner")).toBeNull()
  })
})
