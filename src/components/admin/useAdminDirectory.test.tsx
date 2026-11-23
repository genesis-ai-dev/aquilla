import { describe, it, expect, vi } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAdminDirectory } from "./useAdminDirectory"
import type { AdminListPage, AdminListQuery } from "@/lib/frontier/admin"

function page(query: AdminListQuery, rows: string[]): AdminListPage<string> {
  return {
    rows,
    total: 80,
    limit: query.limit,
    offset: query.offset,
    overdue: null,
  }
}

describe("useAdminDirectory", () => {
  it("does not load while disabled", () => {
    const load = vi.fn()
    renderHook(() =>
      useAdminDirectory({
        enabled: false,
        load,
        queryKey: "people",
        initialSort: { id: "user", desc: false },
        debounceMs: 0,
      }),
    )
    expect(load).not.toHaveBeenCalled()
  })

  it("loads the first page, appends the next page, and replaces on search", async () => {
    const load = vi.fn(async (query: AdminListQuery) =>
      page(query, query.q ? ["beta"] : query.offset === 0 ? ["a"] : ["b"]),
    )
    const { result } = renderHook(() =>
      useAdminDirectory({
        load,
        queryKey: "projects",
        initialSort: { id: "name", desc: false },
        debounceMs: 0,
      }),
    )
    await waitFor(() => expect(result.current.rows).toEqual(["a"]))
    expect(load.mock.calls[0]?.[0]).toMatchObject({ limit: 50, offset: 0, sort: "name", dir: "asc" })
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.rows).toEqual(["a", "b"]))
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }))

    act(() => result.current.setSearch("beta"))
    await waitFor(() => expect(result.current.rows).toEqual(["beta"]))
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ q: "beta", offset: 0 }))
  })
})
