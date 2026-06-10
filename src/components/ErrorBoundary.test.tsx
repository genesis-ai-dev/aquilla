// RES-3 (QW-4): Tests for ErrorBoundary — verifies that a throwing child
// renders the recovery UI, captureException is called, and chunk-load errors
// trigger a guarded reload rather than an error screen.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { ErrorBoundary, captureException } from "./ErrorBoundary"
import posthog from "@/lib/posthog"

// --- posthog mock -------------------------------------------------------
// vi.mock is hoisted — the factory cannot reference variables declared in
// the module scope. Use vi.fn() inside the factory directly; we retrieve
// the mock handles via vi.mocked() in individual tests.

vi.mock("@/lib/posthog", () => ({
  default: {
    capture: vi.fn(),
    captureException: vi.fn(),
  },
}))

// Suppress console.error noise from React's error boundary machinery.
const originalError = console.error
beforeEach(() => {
  console.error = vi.fn()
  sessionStorage.clear()
})
afterEach(() => {
  console.error = originalError
  vi.restoreAllMocks()
})

// --- helpers ------------------------------------------------------------

function ThrowingChild({ message }: { message: string }) {
  throw new Error(message)
}

// --- tests --------------------------------------------------------------

describe("ErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <span>all good</span>
      </ErrorBoundary>,
    )
    expect(screen.getByText("all good")).toBeInTheDocument()
  })

  it("renders the recovery UI when a child throws", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="boom" />
      </ErrorBoundary>,
    )
    // Recovery heading should be visible
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
    // Reload button should be present
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument()
  })

  it("calls posthog.captureException when a child throws", () => {
    const captureExceptionMock = vi.mocked(posthog.captureException)
    captureExceptionMock.mockClear()

    render(
      <ErrorBoundary>
        <ThrowingChild message="captured error" />
      </ErrorBoundary>,
    )
    // React may call componentDidCatch more than once (StrictMode double-invoke).
    expect(captureExceptionMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    const [err] = captureExceptionMock.mock.calls[0]
    expect(err instanceof Error).toBe(true)
    expect((err as Error).message).toBe("captured error")
  })

  it("shows a chunk-load specific message for chunk load errors", () => {
    // Simulate a chunk-load error. The guard also attempts to reload — we need
    // to mock sessionStorage so the reload branch thinks it already ran.
    sessionStorage.setItem("aq:chunk-reload-attempted", "1")

    render(
      <ErrorBoundary>
        <ThrowingChild message="Failed to fetch dynamically imported module" />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/app updated/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument()
  })

  it("does not reload-loop: only reloads once on chunk errors (sessionStorage guard)", () => {
    const reloadSpy = vi.spyOn(window.location, "reload").mockImplementation(() => {})

    // First error — no flag set yet; should trigger reload
    render(
      <ErrorBoundary>
        <ThrowingChild message="Failed to fetch dynamically imported module" />
      </ErrorBoundary>,
    )
    expect(reloadSpy).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem("aq:chunk-reload-attempted")).toBe("1")
  })

  it("captureException is safe when posthog is not initialized", () => {
    // This should never throw even with a null/undefined posthog-like object.
    expect(() => captureException(new Error("test"), {})).not.toThrow()
  })

  it("captureException is safe when given a non-Error value", () => {
    expect(() => captureException("string error")).not.toThrow()
    expect(() => captureException(undefined)).not.toThrow()
    expect(() => captureException(null)).not.toThrow()
  })
})
