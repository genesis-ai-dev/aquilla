/**
 * AQU-266: Tests for global error boundary + crash telemetry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ErrorBoundary } from "./ErrorBoundary"
import { CHUNK_NOTICE_ID } from "@/lib/chunk-reload"

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

  // AQU-642: the e2e Workspace page object races this hook against the first
  // cell row so a render throw in the editor fails as "editor crashed at
  // mount" instead of a bare 30-second `[data-cell-id]` locator timeout.
  // Changing either attribute silently blinds that guard, so pin both here.
  it("marks the fallback with the data-slot hook the e2e page object matches", () => {
    const { container } = render(
      <ErrorBoundary>
        <AlwaysThrows />
      </ErrorBoundary>,
    )
    const fallback = container.querySelector('[data-slot="error-boundary-fallback"]')
    expect(fallback).not.toBeNull()
    // Unlabelled boundaries report the same name crash telemetry uses.
    expect(fallback).toHaveAttribute("data-boundary", "root")
  })

  it("names the boundary in data-boundary so a crash says which surface threw", () => {
    const { container } = render(
      <ErrorBoundary label="project-workspace">
        <AlwaysThrows />
      </ErrorBoundary>,
    )
    expect(container.querySelector('[data-slot="error-boundary-fallback"]'))
      .toHaveAttribute("data-boundary", "project-workspace")
  })

  it("does not mark a healthy subtree with the crash hook", () => {
    const { container } = render(
      <ErrorBoundary>
        <div data-testid="child">hello</div>
      </ErrorBoundary>,
    )
    expect(container.querySelector('[data-slot="error-boundary-fallback"]')).toBeNull()
  })

  it("calls posthog.captureException once when a child throws", () => {
    render(
      <ErrorBoundary label="reference-panel">
        <AlwaysThrows />
      </ErrorBoundary>,
    )
    expect(posthog.captureException).toHaveBeenCalledOnce()
    // AQU-1572: flat — captureException's second argument *is* the property
    // bag, so these land as event properties, not under a nested `properties`.
    expect(posthog.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "test render error" }),
      expect.objectContaining({ source: "react_error_boundary", boundary: "reference-panel" }),
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
// Window global handler tests. AQU-1572: on the web, posthog-js's
// `capture_exceptions` already reports uncaught errors and rejections, so these
// handlers must not capture as well (every error landed twice). In the Tauri
// desktop shell its autocapture script is blocked by CSP, so there they are the
// one capture. Either way they still drive chunk-reload recovery.
// ---------------------------------------------------------------------------
describe("window error handlers", () => {
  function dispatchError(err: Error) {
    window.dispatchEvent(new ErrorEvent("error", { error: err, message: err.message }))
  }

  function dispatchRejection(reason: unknown) {
    // happy-dom does not expose PromiseRejectionEvent; synthesise via CustomEvent
    // so the listener receives the same shape our handler expects (event.reason).
    window.dispatchEvent(Object.assign(new CustomEvent("unhandledrejection"), { reason }))
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI__
  })

  it("does not capture an uncaught error on the web — PostHog autocapture owns it", () => {
    dispatchError(new Error("global error"))
    expect(posthog.captureException).not.toHaveBeenCalled()
  })

  it("does not capture an unhandled rejection on the web — PostHog autocapture owns it", () => {
    dispatchRejection(new Error("rejection error"))
    expect(posthog.captureException).not.toHaveBeenCalled()
  })

  it("captures each once in the desktop shell, where autocapture cannot load", () => {
    ;(window as unknown as Record<string, unknown>).__TAURI__ = {}
    const err = new Error("global error")
    const rejection = new Error("rejection error")
    dispatchError(err)
    dispatchRejection(rejection)
    expect(posthog.captureException).toHaveBeenCalledTimes(2)
    expect(posthog.captureException).toHaveBeenCalledWith(err, { source: "window.onerror" })
    expect(posthog.captureException).toHaveBeenCalledWith(rejection, { source: "unhandledrejection" })
  })

  it("still reloads once for a stale chunk reported as an uncaught error or rejection", () => {
    sessionStorage.clear()
    const reloadSpy = vi.fn()
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    })
    dispatchError(new Error("Failed to fetch dynamically imported module: /assets/a-1.js"))
    dispatchRejection(new Error("Failed to fetch dynamically imported module: /assets/b-2.js"))
    expect(reloadSpy).toHaveBeenCalledTimes(2)
    expect(posthog.captureException).not.toHaveBeenCalled()
    document.getElementById(CHUNK_NOTICE_ID)?.remove()
  })
})

// ---------------------------------------------------------------------------
// Chunk-load recovery (RES-3 / audit QW-4 / AQU-1405): stale lazy chunks after
// a redeploy get ONE automatic reload per failing chunk URL, then the "App
// updated" fallback. The guard itself is unit-tested in
// src/lib/chunk-reload.test.ts; these pin the boundary's wiring to it.
// ---------------------------------------------------------------------------
describe("chunk-load recovery", () => {
  const CHUNK_URL = "/assets/app-chunk-BfoUWN3w.js"

  function ThrowsChunkError(): ReactNode {
    throw new Error(`Failed to fetch dynamically imported module: ${CHUNK_URL}`)
  }

  beforeEach(() => {
    sessionStorage.clear()
  })

  it("reloads once on the first failure of a chunk", () => {
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
    expect(sessionStorage.getItem("aq:chunk-reload-attempted")).toBe(JSON.stringify([CHUNK_URL]))
  })

  it("shows the 'App updated' fallback instead of reload-looping on the same chunk", () => {
    sessionStorage.setItem("aq:chunk-reload-attempted", JSON.stringify([CHUNK_URL]))
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

  it("non-chunk errors do not consume the chunk-reload guard", () => {
    render(
      <ErrorBoundary>
        <AlwaysThrows />
      </ErrorBoundary>,
    )
    expect(sessionStorage.getItem("aq:chunk-reload-attempted")).toBeNull()
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
  })
})
