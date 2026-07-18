/**
 * AQU-266: Tests for global error boundary + crash telemetry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ErrorBoundary } from "./ErrorBoundary"

// ---------------------------------------------------------------------------
// Mock posthog so captureException calls are interceptable without a real
// PostHog key / network connection.
// ---------------------------------------------------------------------------
vi.mock("@/lib/posthog", () => ({
  default: {
    captureException: vi.fn(),
    capture: vi.fn(),
  },
}))

import posthog from "@/lib/posthog"

// ---------------------------------------------------------------------------
// Helper: a component that always throws during render.
// ---------------------------------------------------------------------------
function AlwaysThrows(): never {
  throw new Error("test render error")
}

// Suppress React's console.error output for expected boundary errors.
let consoleErrorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  consoleErrorSpy.mockRestore()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Boundary rendering tests
// ---------------------------------------------------------------------------
describe("ErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">hello</div>
      </ErrorBoundary>,
    )
    expect(screen.getByTestId("child")).toBeInTheDocument()
  })

  it("renders the fallback screen when a child throws", () => {
    render(
      <ErrorBoundary>
        <AlwaysThrows />
      </ErrorBoundary>,
    )
    // Branded recovery screen must be visible (not white screen).
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
    expect(screen.getByText(/Your work is saved locally/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument()
  })

  it("calls posthog.captureException when a child throws", () => {
    render(
      <ErrorBoundary>
        <AlwaysThrows />
      </ErrorBoundary>,
    )
    expect(posthog.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "test render error" }),
      expect.objectContaining({ properties: expect.objectContaining({ source: "react_error_boundary" }) }),
    )
  })

  it("reload button calls window.location.reload", () => {
    const reloadSpy = vi.fn()
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    })

    render(
      <ErrorBoundary>
        <AlwaysThrows />
      </ErrorBoundary>,
    )
    const button = screen.getByRole("button", { name: /reload/i })
    fireEvent.click(button)
    expect(reloadSpy).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Window global handler registration tests
// ---------------------------------------------------------------------------
describe("window error handlers", () => {
  it("window.onerror handler is registered and forwards to posthog.captureException", () => {
    const err = new Error("global error")
    const event = new ErrorEvent("error", { error: err, message: err.message })
    window.dispatchEvent(event)
    expect(posthog.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ properties: expect.objectContaining({ source: "window.onerror" }) }),
    )
  })

  it("unhandledrejection handler is registered and forwards to posthog.captureException", () => {
    const err = new Error("rejection error")
    // happy-dom does not expose PromiseRejectionEvent; synthesise via CustomEvent
    // so the listener receives the same shape our handler expects (event.reason).
    const event = Object.assign(new CustomEvent("unhandledrejection"), { reason: err })
    window.dispatchEvent(event)
    expect(posthog.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ properties: expect.objectContaining({ source: "unhandledrejection" }) }),
    )
  })
})

// ---------------------------------------------------------------------------
// Chunk-load recovery (RES-3 / audit QW-4): stale lazy chunks after a redeploy
// get ONE automatic reload (sessionStorage-guarded), then the "App updated"
// fallback.
// ---------------------------------------------------------------------------
describe("chunk-load recovery", () => {
  function ThrowsChunkError(): ReactNode {
    throw new Error("Failed to fetch dynamically imported module: /assets/x.js")
  }

  beforeEach(() => {
    sessionStorage.clear()
  })

  it("reloads once on the first chunk error in a session", () => {
    const reloadSpy = vi.fn()
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    })
    render(
      <ErrorBoundary>
        <ThrowsChunkError />
      </ErrorBoundary>,
    )
    expect(reloadSpy).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem("aq:chunk-reload-attempted")).toBe("1")
  })

  it("shows the 'App updated' fallback instead of reload-looping when the flag is set", () => {
    sessionStorage.setItem("aq:chunk-reload-attempted", "1")
    const reloadSpy = vi.fn()
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    })
    render(
      <ErrorBoundary>
        <ThrowsChunkError />
      </ErrorBoundary>,
    )
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(screen.getByText(/app updated/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument()
  })

  it("non-chunk errors do not consume the chunk-reload flag", () => {
    render(
      <ErrorBoundary>
        <AlwaysThrows />
      </ErrorBoundary>,
    )
    expect(sessionStorage.getItem("aq:chunk-reload-attempted")).toBeNull()
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
  })
})
