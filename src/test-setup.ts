import "fake-indexeddb/auto"
import "@testing-library/jest-dom/vitest"
import { afterEach, vi } from "vitest"
import { cleanup, configure } from "@testing-library/react"
import { resetWindowFocusRevalidateForTests } from "@/lib/sync/window-focus-revalidate"
import { resetAllRequestCoalescersForTests } from "@/lib/request-coalescer"

// Cloudflare Workers Builds runs this suite beside the lint and agent-worker
// lanes in one bounded container (scripts/cloudflare-ci-checks.mjs). Under that
// contention, findBy*/waitFor calls that settle in a few milliseconds locally
// have blown Testing Library's 1 s default and turned the preview gate red on
// tests unrelated to the change. Pair with the WORKERS_CI testTimeout in
// vite.config.ts; local runs keep the default so a real hang still fails fast.
if (process.env.WORKERS_CI) configure({ asyncUtilTimeout: 5_000 })

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
  // Module-level rate limits / caches would otherwise leak across tests: a
  // focus dispatched in one test would suppress the next test's focus for 5s,
  // and a roster cached in one test would answer the next test's fetch.
  resetWindowFocusRevalidateForTests()
  resetAllRequestCoalescersForTests()
})
