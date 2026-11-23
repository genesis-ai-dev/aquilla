import { describe, it, expect, vi } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAdminDirectory } from "./useAdminDirectory"
import type { AdminListPage, AdminListQuery } from "@/lib/frontier/admin"

function page(query: AdminListQuery): AdminListPage<string> {
  return {
    rows: query.q ? [query.q] : ["a"],
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

  it("loads the first page, then sends a search from page 0", async () => {
    const load = vi.fn(async (query: AdminListQuery) => page(query))
    const { result } = renderHook(() =>
      useAdminDirectory({
        load,
        queryKey: "projects",
        initialSort: { id: "name", desc: false },
        debounceMs: 0,
      }),
    )
    await waitFor(() => expect(load).toHaveBeenCalled())
    expect(load.mock.calls[0]?.[0]).toMatchObject({ limit: 50, offset: 0, sort: "name", dir: "asc" })

    act(() => result.current.setPage(1))
    await waitFor(() => expect(load).toHaveBeenCalledWith(expect.objectContaining({ offset: 50 })))

    act(() => result.current.setSearch("beta"))
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ q: "beta", offset: 0 })),
    )
  })
})
