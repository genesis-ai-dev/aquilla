import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useOrgSwitcherCatalog } from "./useOrgSwitcherCatalog"

const listOrgsPage = vi.fn()
vi.mock("@/lib/frontier/orgs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/orgs")>()
  return {
    ...actual,
    listOrgsPage: (...a: unknown[]) => listOrgsPage(...a),
  }
})

beforeEach(() => {
  listOrgsPage.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("useOrgSwitcherCatalog", () => {
  it("does not fetch until enabled and open", async () => {
    listOrgsPage.mockResolvedValue({ orgs: [], nextCursor: null })
    const { rerender } = renderHook(
      (props: { open: boolean; enabled: boolean }) =>
        useOrgSwitcherCatalog({ jwt: "jwt", query: "", ...props }),
      { initialProps: { open: false, enabled: true } },
    )
    expect(listOrgsPage).not.toHaveBeenCalled()
    rerender({ open: true, enabled: false })
    expect(listOrgsPage).not.toHaveBeenCalled()
    rerender({ open: true, enabled: true })
    await waitFor(() => expect(listOrgsPage).toHaveBeenCalledTimes(1))
  })

  it("replaces the list on a new query and appends on loadMore", async () => {
    listOrgsPage
      .mockResolvedValueOnce({
        orgs: [{ id: 1, name: "Acme", role: { level: 700, name: "owner" } }],
        nextCursor: "1:Acme",
      })
      .mockResolvedValueOnce({
        orgs: [{ id: 2, name: "Beta", role: { level: 700, name: "admin" }, viaPlatformAdmin: true }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        orgs: [{ id: 3, name: "Gamma", role: { level: 700, name: "admin" }, viaPlatformAdmin: true }],
        nextCursor: null,
      })

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) =>
        useOrgSwitcherCatalog({ jwt: "jwt", open: true, enabled: true, query }),
      { initialProps: { query: "" } },
    )

    await waitFor(() => expect(result.current.orgs).toEqual([
      { id: 1, name: "Acme", role: { level: 700, name: "owner" } },
    ]))
    expect(result.current.hasMore).toBe(true)

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.orgs.map((o) => o.id)).toEqual([1, 2]))
    expect(result.current.hasMore).toBe(false)

    rerender({ query: "gam" })
    expect(result.current.searching).toBe(true)
    await waitFor(() => expect(result.current.orgs.map((o) => o.name)).toEqual(["Gamma"]))
    expect(result.current.searching).toBe(false)
  })
})
