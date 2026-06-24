import "fake-indexeddb/auto"
import "@testing-library/jest-dom/vitest"
import { afterEach, vi } from "vitest"
import { cleanup } from "@testing-library/react"

// Stub PostHog globally. A real VITE_POSTHOG_KEY in a developer's .env makes
// src/lib/posthog.ts call posthog.init() at import time, which tries to fetch a
// remote config script that happy-dom refuses to load (DOMException), crashing
// any component that imports the module. Analytics should never fire from unit
// tests anyway. Tests that assert on capture calls (e.g. ErrorBoundary) override
// this with their own vi.mock. The Proxy returns a fresh no-op for every method
// so we never have to enumerate PostHog's API surface here.
vi.mock("@/lib/posthog", () => ({
  default: new Proxy({}, { get: () => vi.fn() }),
}))

afterEach(() => {
  cleanup()
})
