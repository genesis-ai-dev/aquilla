import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import type { CellRow } from "@/lib/sync/cells-read-types"

const fetchAllFileCells = vi.fn<(...args: unknown[]) => Promise<CellRow[]>>()
vi.mock("@/lib/sync/cells-read", () => ({
  fetchAllFileCells: (...args: unknown[]) => fetchAllFileCells(...args),
}))

const { useForecastCorpus } = await import("./useForecastCorpus")

afterEach(() => {
  cleanup()
  fetchAllFileCells.mockReset()
})

type Cell = { id: string; fileId: string; index: number; translated: string; validated: boolean; status: "validated" | "unvalidated" }

function cell(id: string, translated: string, validated = true): Cell {
  return { id, fileId: "f1", index: Number(id.replace(/\D/g, "")), translated, validated, status: validated ? "validated" : "unvalidated" }
}

function row(cellId: string, value: string): CellRow {
  return {
    cellId, side: "target", targetLang: "", value, valueHtml: null, type: null, canonicalRef: null, anchorCellId: null,
    eventId: `e-${cellId}`, sourceEventId: null, lastEditor: null, lastEditAt: 0, validated: true, wordCount: 1,
  }
}

const files = [{ id: "f1" }, { id: "f2" }]

describe("useForecastCorpus", () => {
  it("feeds the active file incrementally and loads other files on first use", async () => {
    fetchAllFileCells.mockResolvedValue([row("x1", "the river flows east")])
    const { result, rerender } = renderHook(
      ({ cells }: { cells: Cell[] }) =>
        useForecastCorpus({
          enabled: true,
          projectId: "p",
          files,
          activeFileId: "f1",
          activeCells: cells,
          getToken: async () => "jwt",
          lane: "",
        }),
      { initialProps: { cells: [cell("c1", "grace and peace"), cell("c2", "")] } },
    )
    await waitFor(() => expect(result.current).not.toBeNull())
    const client = result.current!
    expect((await client.suggest("grace and ", ""))[0]?.word).toBe("peace")

    // First query triggered the other-file load (not the active file).
    await waitFor(() => expect(fetchAllFileCells).toHaveBeenCalledTimes(1))
    expect(fetchAllFileCells.mock.calls[0]?.[1]).toBe("f2")
    await waitFor(async () => expect((await client.suggest("the river ", ""))[0]?.word).toBe("flows"))

    // An edit re-sends just that cell; a removed cell leaves the index.
    rerender({ cells: [cell("c1", "grace and truth")] })
    await waitFor(async () => expect((await client.suggest("grace and ", ""))[0]?.word).toBe("truth"))
    rerender({ cells: [] })
    await waitFor(async () => expect(await client.suggest("grace and ", "")).toEqual([]))
  })

  it("is off when disabled", () => {
    const { result } = renderHook(() =>
      useForecastCorpus({ enabled: false, projectId: "p", files, activeFileId: "f1", activeCells: [], getToken: async () => null, lane: "" }),
    )
    expect(result.current).toBeNull()
  })
})
