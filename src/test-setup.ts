import "fake-indexeddb/auto"
import "@testing-library/jest-dom/vitest"
import { afterEach, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import type { ReactNode } from "react"
import { resetWindowFocusRevalidateForTests } from "@/lib/sync/window-focus-revalidate"
import { resetAllRequestCoalescersForTests } from "@/lib/request-coalescer"

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
})
