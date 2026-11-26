import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { clearPortfolioSeeds } from "@/lib/frontier/portfolio-seed"
import { useProjectDirectory } from "./useProjectDirectory"

const getPortfolioPage = vi.fn()
const getPortfoliosPage = vi.fn()
vi.mock("@/lib/frontier/portfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/portfolio")>()
  return {
    ...actual,
    getPortfolioPage: (...a: unknown[]) => getPortfolioPage(...a),
    getPortfoliosPage: (...a: unknown[]) => getPortfoliosPage(...a),
  }
})

beforeEach(() => {
  clearPortfolioSeeds()
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })))
  getPortfolioPage.mockReset()
  getPortfoliosPage.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("useProjectDirectory", () => {
  it("does not fetch until enabled with a jwt and at least one org", async () => {
    getPortfolioPage.mockResolvedValue({ projects: [], nextCursor: null })
    type Props = { jwt: string | null; enabled: boolean; orgIds: number[] }
    const initialProps: Props = { jwt: null, enabled: true, orgIds: [1] }
    const { rerender } = renderHook(
      (props: Props) => useProjectDirectory({ query: "", ...props }),
      { initialProps },
    )
    expect(getPortfolioPage).not.toHaveBeenCalled()
    rerender({ jwt: "jwt", enabled: false, orgIds: [1] })
    expect(getPortfolioPage).not.toHaveBeenCalled()
    rerender({ jwt: "jwt", enabled: true, orgIds: [] })
    expect(getPortfolioPage).not.toHaveBeenCalled()
    rerender({ jwt: "jwt", enabled: true, orgIds: [1] })
    await waitFor(() => expect(getPortfolioPage).toHaveBeenCalledTimes(1))
  })

  it("paints the prior first page on return while revalidating, then replaces it", async () => {
    const open = () => renderHook(() => useProjectDirectory({ jwt: "jwt", enabled: true, orgIds: [1], query: "" }))
    const page = { projects: [{ id: "old" }], nextCursor: "old-cursor" }
    getPortfolioPage.mockResolvedValueOnce(page)
    const first = open()
    await waitFor(() => expect(first.result.current.hasMore).toBe(true))
    first.unmount()
    let finish!: (page: unknown) => void
    getPortfolioPage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const back = open()
    expect(back.result.current).toMatchObject({ projects: page.projects, loading: false, hasMore: false })
    expect(getPortfolioPage.mock.lastCall?.[2].cached).toBe(page)
    await act(async () => finish({ projects: [{ id: "new" }], nextCursor: null }))
    expect(back.result.current.projects).toEqual([{ id: "new" }])
  })

  it("discards a late page from the previous account", async () => {
    let finish!: (page: unknown) => void
    getPortfolioPage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    getPortfolioPage.mockResolvedValueOnce({ projects: [{ id: "new" }], nextCursor: null })
    const { result, rerender } = renderHook(
      ({ jwt }) => useProjectDirectory({ jwt, enabled: true, orgIds: [1], query: "" }),
      { initialProps: { jwt: "first" } },
    )
    rerender({ jwt: "second" })
    await waitFor(() => expect(result.current.projects.map(p => p.id)).toEqual(["new"]))
    await act(async () => finish({ projects: [{ id: "old" }], nextCursor: null }))
    expect(result.current.projects.map(p => p.id)).toEqual(["new"])
  })

  it("searches off-page names locally and refreshes their details when names are unchanged", async () => {
    const names = [["p1", "First", 1], ["p2", "Last", 2]]
    const indexFetch = vi.fn(async (_url, init) => {
      const prior = JSON.parse(init.body).revision
      return Response.json(prior === "v" ? { revision: "v", unchanged: true } : { revision: "v", projects: names })
    })
    vi.stubGlobal("fetch", indexFetch)
    let count = 1
    getPortfoliosPage.mockImplementation(async (_jwt, _orgs, opts) => ({
      projects: opts.projectIds ? [{ id: "p2", name: "Last", totalCells: count }] : [], nextCursor: null,
    }))
    const { result, rerender } = renderHook(({ query, refreshKey }) =>
      useProjectDirectory({ jwt: "index-user", enabled: true, orgIds: [1, 2], query, refreshKey }),
      { initialProps: { query: "", refreshKey: 0 } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ query: "last", refreshKey: 0 })
    expect(result.current.projects[0]).toMatchObject({ id: "p2", nameOnly: true })
    await waitFor(() => expect(result.current.projects[0]?.totalCells).toBe(1))
    expect(getPortfoliosPage.mock.calls.every(([, , opts]) => !opts.q)).toBe(true)
    count = 3
    rerender({ query: "last", refreshKey: 1 })
    await waitFor(() => expect(result.current.projects[0]?.totalCells).toBe(3))
    expect(indexFetch).toHaveBeenCalledTimes(2)
  })

  it("replaces the list on a new query and appends on loadMore", async () => {
    getPortfolioPage
      .mockResolvedValueOnce({
        projects: [{ id: "a", name: "Acts", totalCells: 0, validatedCells: 0, filledCells: 0, aiDraftedCells: 0, lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null }],
        nextCursor: "a:Acts",
      })
      .mockResolvedValueOnce({
        projects: [{ id: "j", name: "John", totalCells: 0, validatedCells: 0, filledCells: 0, aiDraftedCells: 0, lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        projects: [{ id: "m", name: "Mark", totalCells: 0, validatedCells: 0, filledCells: 0, aiDraftedCells: 0, lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null }],
        nextCursor: null,
      })

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) =>
        useProjectDirectory({ jwt: "jwt", enabled: true, orgIds: [1], query }),
      { initialProps: { query: "" } },
    )

    await waitFor(() => expect(result.current.projects.map((p) => p.id)).toEqual(["a"]))
    expect(result.current.hasMore).toBe(true)

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.projects.map((p) => p.id)).toEqual(["a", "j"]))
    expect(result.current.hasMore).toBe(false)

    rerender({ query: "mar" })
    expect(result.current.searching).toBe(true)
    await waitFor(() => expect(result.current.projects.map((p) => p.name)).toEqual(["Mark"]))
    expect(result.current.searching).toBe(false)
  })

  it("fans out through getPortfoliosPage when more than one org is in scope", async () => {
    getPortfoliosPage.mockResolvedValue({
      projects: [
        { id: "a", name: "Acts", orgId: 1, totalCells: 0, validatedCells: 0, filledCells: 0, aiDraftedCells: 0, lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null },
      ],
      nextCursor: null,
    })
    const { result } = renderHook(() =>
      useProjectDirectory({ jwt: "jwt", enabled: true, orgIds: [2, 1], query: "" }),
    )
    await waitFor(() => expect(result.current.projects.map((p) => p.id)).toEqual(["a"]))
    expect(getPortfolioPage).not.toHaveBeenCalled()
    expect(getPortfoliosPage).toHaveBeenCalledWith(
      "jwt",
      [1, 2],
      expect.objectContaining({ q: "" }),
    )
  })
})
