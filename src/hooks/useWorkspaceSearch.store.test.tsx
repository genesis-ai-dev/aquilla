/**
 * AQU-2654: the search state is a store, so the component that OWNS the search
 * (the project workspace) does not re-render when a search runs — only the
 * surfaces that draw results do.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, renderHook, screen } from "@testing-library/react"
import {
  useWorkspaceSearch,
  useWorkspaceSearchController,
  type WorkspaceSearchController,
} from "./useWorkspaceSearch"
import { WorkspaceSearchState } from "@/components/search/WorkspaceSearchState"
import { fetchProjectSearch } from "@/lib/sync/search-read"

vi.mock("@/lib/sync/search-read", () => ({
  fetchProjectSearch: vi.fn(),
  fetchParallelPassages: vi.fn(),
}))

const hit = (cellId: string) => ({
  cellId,
  fileId: "f1",
  side: "target" as const,
  value: "light",
  snippet: "<mark>light</mark>",
  rank: 0.1,
})

/** What the fetcher resolves: the rows, and a total that defaults to all of them. */
const page = (results: ReturnType<typeof hit>[], total = results.length, totalIsLowerBound = false) => ({
  results,
  total,
  totalIsLowerBound,
})

beforeEach(() => {
  vi.mocked(fetchProjectSearch).mockReset()
})

describe("useWorkspaceSearchController (AQU-2654)", () => {
  it("a search redraws the subscribed surface and never the owner", async () => {
    vi.mocked(fetchProjectSearch).mockResolvedValue(page([hit("c1"), hit("c2")]))
    let ownerRenders = 0
    let controller!: WorkspaceSearchController
    function Owner() {
      ownerRenders += 1
      controller = useWorkspaceSearchController({ projectId: "p1", getToken: async () => "jwt" })
      return (
        <WorkspaceSearchState store={controller.store}>
          {({ results, loading }) => <p>{loading ? "searching" : `${results.length} hits`}</p>}
        </WorkspaceSearchState>
      )
    }
    render(<Owner />)
    expect(screen.getByText("0 hits")).toBeInTheDocument()
    const rendersBefore = ownerRenders

    await act(async () => {
      await controller.search("light")
    })
    expect(screen.getByText("2 hits")).toBeInTheDocument()
    await act(async () => {
      controller.clear()
    })
    expect(screen.getByText("0 hits")).toBeInTheDocument()

    expect(ownerRenders).toBe(rendersBefore)
  })

  it("asks the server for the one file a file-scoped search names", async () => {
    // Narrowing in the browser was not enough: the server had already cut the
    // project-wide list to one page, so a file's hits could all be on page 2.
    vi.mocked(fetchProjectSearch).mockResolvedValue(page([hit("c1")]))
    const { result } = renderHook(() =>
      useWorkspaceSearchController({ projectId: "p1", getToken: async () => "jwt" }),
    )
    await act(async () => {
      await result.current.search("器皿", { fileId: "f1" })
    })
    expect(vi.mocked(fetchProjectSearch).mock.calls[0][2]).toMatchObject({ fileId: "f1" })
    expect(result.current.store.getSnapshot().results.map((r) => r.cellId)).toEqual(["c1"])

    await act(async () => {
      await result.current.search("器皿")
    })
    expect(vi.mocked(fetchProjectSearch).mock.calls[1][2].fileId).toBeUndefined()
  })

  it("lands a finished search as one transition: results, ready and loading together", async () => {
    vi.mocked(fetchProjectSearch).mockResolvedValue(page([hit("c1")]))
    const { result } = renderHook(() =>
      useWorkspaceSearchController({ projectId: "p1", getToken: async () => "jwt" }),
    )
    const seen: Array<{ results: number; loading: boolean; ready: boolean }> = []
    const { store } = result.current
    store.subscribe(() => {
      const s = store.getSnapshot()
      seen.push({ results: s.results.length, loading: s.loading, ready: s.ready })
    })
    await act(async () => {
      await result.current.search("light")
    })
    expect(seen).toEqual([
      { results: 0, loading: true, ready: false },
      { results: 1, loading: false, ready: true },
    ])
  })

  // AQU-2732: the list is cut at the limit asked for. The total beside it is
  // what lets a surface say "50 of 63" instead of "50 results".
  it("carries the total beside the cut list, and asks for the limit it was given", async () => {
    vi.mocked(fetchProjectSearch).mockResolvedValue(page([hit("c1"), hit("c2")], 63))
    const { result } = renderHook(() =>
      useWorkspaceSearchController({ projectId: "p1", getToken: async () => "jwt" }),
    )
    await act(async () => {
      await result.current.search("temple", { limit: 500 })
    })
    expect(vi.mocked(fetchProjectSearch).mock.calls[0][2]).toMatchObject({ limit: 500 })
    expect(result.current.store.getSnapshot()).toMatchObject({ total: 63, totalIsLowerBound: false })
    expect(result.current.store.getSnapshot().results).toHaveLength(2)

    act(() => result.current.clear())
    expect(result.current.store.getSnapshot()).toMatchObject({ results: [], total: 0 })
  })

  it("clearing an already-empty result list announces nothing", () => {
    const { result } = renderHook(() =>
      useWorkspaceSearchController({ projectId: "p1", getToken: async () => "jwt" }),
    )
    const listener = vi.fn()
    result.current.store.subscribe(listener)
    act(() => result.current.clear())
    expect(listener).not.toHaveBeenCalled()
  })

  // AQU-2655: the dock clears at once when the box is emptied; a slower answer
  // to the query typed before must not repaint hits under an empty box.
  it("clearing retires a search still in flight", async () => {
    let answer!: (found: ReturnType<typeof page>) => void
    vi.mocked(fetchProjectSearch).mockReturnValue(new Promise((r) => { answer = r }))
    const { result } = renderHook(() =>
      useWorkspaceSearch({ projectId: "p1", getToken: async () => "jwt" }),
    )
    let inFlight!: Promise<void>
    await act(async () => {
      inFlight = result.current.search("light")
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(true)
    act(() => result.current.clear())
    expect(result.current.loading).toBe(false)
    await act(async () => {
      answer(page([hit("c1")]))
      await inFlight
    })
    expect(result.current.results).toHaveLength(0)
    expect(result.current.loading).toBe(false)
  })

  it("drops the previous project's hits when the project changes", async () => {
    vi.mocked(fetchProjectSearch).mockResolvedValue(page([hit("c1")]))
    const { result, rerender } = renderHook(
      ({ projectId }) => useWorkspaceSearch({ projectId, getToken: async () => "jwt" }),
      { initialProps: { projectId: "p1" } },
    )
    await act(async () => {
      await result.current.search("light")
    })
    expect(result.current.results).toHaveLength(1)
    expect(result.current.ready).toBe(true)

    rerender({ projectId: "p2" })
    expect(result.current.results).toHaveLength(0)
    expect(result.current.ready).toBe(false)
  })
})
