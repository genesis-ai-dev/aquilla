import { describe, expect, test } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { LocalStoreProvider, useProjectStore, useLocalStoreState } from "./provider"

function wrapper({ projectId, children }: { projectId: string; children: ReactNode }) {
  return <LocalStoreProvider projectId={projectId}>{children}</LocalStoreProvider>
}

describe("LocalStoreProvider", () => {
  test("opens a per-project store and exposes it once ready", async () => {
    const { result } = renderHook(() => useProjectStore(), {
      wrapper: ({ children }) => wrapper({ projectId: ":memory:", children }),
    })
    // Initially null while async-opening.
    expect(result.current).toBeNull()
    await waitFor(
      () => {
        expect(result.current).not.toBeNull()
      },
      { timeout: 3000 },
    )
    // Sanity: the store can answer queries.
    const rows = await result.current!.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='cells'",
    )
    expect(rows).toHaveLength(1)
  })

  test("useLocalStoreState transitions loading → ready", async () => {
    const { result } = renderHook(() => useLocalStoreState(), {
      wrapper: ({ children }) => wrapper({ projectId: ":memory:", children }),
    })
    expect(result.current.status).toBe("loading")
    await waitFor(
      () => {
        expect(result.current.status).toBe("ready")
      },
      { timeout: 3000 },
    )
  })

  test("useProjectStore throws outside a provider", () => {
    expect(() => renderHook(() => useProjectStore())).toThrow(
      /LocalStoreProvider/,
    )
  })
})
