/**
 * AQU-1011: a target search hit must carry the cell's source text through to
 * the result shape Find & Replace renders. The server field is pairedValue;
 * the panel reads result.paired.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useWorkspaceSearch } from "./useWorkspaceSearch"
import { fetchProjectSearch } from "@/lib/sync/search-read"

vi.mock("@/lib/sync/search-read", () => ({
  fetchProjectSearch: vi.fn(),
  fetchParallelPassages: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(fetchProjectSearch).mockReset()
})

describe("useWorkspaceSearch — paired source (AQU-1011)", () => {
  it("maps a target hit's pairedValue onto the source the replace row shows", async () => {
    vi.mocked(fetchProjectSearch).mockResolvedValue([
      {
        cellId: "c1",
        fileId: "f1",
        side: "target",
        value: "teste",
        snippet: "<mark>teste</mark>",
        rank: 0.2,
        pairedValue: "test",
      },
    ])

    const { result } = renderHook(() =>
      useWorkspaceSearch({
        projectId: "p1",
        getToken: async () => "jwt",
      }),
    )

    await act(async () => {
      await result.current.search("teste", { side: "target" })
    })

    expect(result.current.results).toHaveLength(1)
    expect(result.current.results[0]).toMatchObject({
      translated: "teste",
      original: "",
      paired: "test",
    })
  })

  it("keeps the verse address on the result the replace list labels", async () => {
    vi.mocked(fetchProjectSearch).mockResolvedValue([
      {
        cellId: "c1",
        fileId: "f1",
        side: "target",
        value: "in the beginning",
        snippet: "in the beginning",
        rank: 0.1,
        pairedValue: "In the beginning",
        canonicalRef: "GEN 1:1",
        cellType: "verse",
        placeLabel: null,
        position: 1,
      },
    ])
    const { result } = renderHook(() =>
      useWorkspaceSearch({ projectId: "p1", getToken: async () => "jwt" }),
    )
    await act(async () => {
      await result.current.search("beginning", { side: "target" })
    })
    expect(result.current.results[0]).toMatchObject({
      canonicalRef: "GEN 1:1",
      cellType: "verse",
      placeLabel: null,
      position: 1,
    })
  })

  it("forwards match case, whole word, and regexp to the search request", async () => {
    vi.mocked(fetchProjectSearch).mockResolvedValue([])
    const { result } = renderHook(() =>
      useWorkspaceSearch({ projectId: "p1", getToken: async () => "jwt" }),
    )
    await act(async () => {
      await result.current.search("God", { caseSensitive: true, matchWord: true, useRegexp: true })
    })
    expect(fetchProjectSearch).toHaveBeenCalledWith(
      "p1",
      "God",
      expect.objectContaining({ matchCase: true, wholeWord: true, useRegexp: true }),
      "jwt",
    )
  })
})
