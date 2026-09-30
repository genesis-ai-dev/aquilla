import "fake-indexeddb/auto"
import "@testing-library/jest-dom/vitest"
import { afterEach, expect, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import type { ReactNode } from "react"
import { resetWindowFocusRevalidateForTests } from "@/lib/sync/window-focus-revalidate"
import { resetAllRequestCoalescersForTests } from "@/lib/request-coalescer"
import { clearResolvedProjectSeeds } from "@/lib/sync/project-record-seed"
import {
  createOffMachineFetchGuard,
  takeOffMachineRequestViolations,
} from "./test-setup.fetch-guard"

// Block unit tests from reaching anything off this machine (AQU-1277). The
// auth/sync base URLs fall back to production when VITE_AUTH_BASE is unset, so
// a missing or exhausted fetch mock used to hit api.aquilla.app for real. This
// runs before any test file loads, so it is the value tests capture as their
// `originalFetch` and restore in afterEach. A test that installs its own mock
// (vi.fn / vi.spyOn / vi.stubGlobal) replaces the guard for its own duration
// and is unaffected.
globalThis.fetch = createOffMachineFetchGuard(globalThis.fetch, () => {
  const { testPath, currentTestName } = expect.getState()
  return [testPath, currentTestName].filter(Boolean).join(" › ") || "unknown test"
})

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

// happy-dom has no layout engine, so the real LegendList may paint zero items.
// Directory tables (and EditorTable, unless a file supplies a richer mock)
// render every row so RTL can still query names/cells.
vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")
  return {
    LegendList: React.forwardRef(function MockLegendList(
      {
        data,
        renderItem,
        keyExtractor,
        ListFooterComponent,
        ListHeaderComponent,
        extraData,
        maintainVisibleContentPosition,
      }: {
        data?: unknown[]
        renderItem?: (props: {
          item: unknown
          index: number
          extraData?: unknown
          data: unknown[]
        }) => ReactNode
        keyExtractor?: (item: unknown, index: number) => string
        ListFooterComponent?: React.ComponentType | React.ReactElement | null
        ListHeaderComponent?: React.ComponentType | React.ReactElement | null
        extraData?: unknown
        maintainVisibleContentPosition?: boolean
      },
      ref,
    ) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({
          scroll: 0,
          positionAtIndex: (i: number) => i * 40,
          sizeAtIndex: () => 40,
        }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))
      const asNode = (
        component: React.ComponentType | React.ReactElement | null | undefined,
      ) => {
        if (component == null) return null
        return React.isValidElement(component)
          ? component
          : React.createElement(component as React.ComponentType)
      }
      const items = data ?? []
      return React.createElement(
        "div",
        {
          "data-testid": "legend-list-mock",
          "data-maintain-visible-content-position":
            maintainVisibleContentPosition ? "true" : "false",
        },
        asNode(ListHeaderComponent),
        items.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? String(index) },
            renderItem?.({ item, index, extraData, data: items }),
          ),
        ),
        asNode(ListFooterComponent),
      )
    }),
  }
})

afterEach(() => {
  cleanup()
  // Module-level rate limits / caches would otherwise leak across tests: a
  // focus dispatched in one test would suppress the next test's focus for 5s,
  // and a roster cached in one test would answer the next test's fetch.
  resetWindowFocusRevalidateForTests()
  resetAllRequestCoalescersForTests()
  // AQU-1325's seed map lives for the lifetime of the TAB, and every test is a
  // fresh tab. Left in place, a project id resolved by one test puts the next
  // test that mounts the same id on the warm path (ready at once, then a
  // revalidated record) while it still reads as a cold-load test.
  clearResolvedProjectSeeds()

  // The guard throws at the call site, but callers routinely wrap fetch in
  // try/catch, which would swallow it and leave the test green despite a
  // blocked production call. Re-raise here so the violation is always fatal.
  const blocked = takeOffMachineRequestViolations()
  if (blocked.length > 0) {
    throw new Error(
      `[AQU-1277] This test made ${blocked.length} off-machine request(s), which were ` +
        `blocked before leaving the machine:\n  ${blocked.join("\n  ")}\n` +
        `Mock fetch for these calls. See src/test-setup.fetch-guard.ts.`,
    )
  }
})
