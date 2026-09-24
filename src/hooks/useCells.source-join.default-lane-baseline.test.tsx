// PRE-AQU-1240 characterization baseline — pins useCells source/default-lane join:
// laneOf(source) === laneOf(defaultTarget) === '', so the default-lane view admits
// the source row alongside the '' target row. UPDATE (do not silently delete)
// when `''` is eliminated for target rows (AQU-1240 slice 0).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { CellRow } from "@/lib/sync/cells-read-types"

const fetchAllMock = vi.fn<
  (projectId: string, fileId: string, jwt: string, side?: "source" | "target") => Promise<CellRow[]>
>()

vi.mock("@/lib/sync/cells-read", () => ({
  streamFileCells: async (
    projectId: string,
    fileId: string,
    jwt: string,
    onPage: (rows: CellRow[], isLast: boolean) => void | Promise<void>,
    side?: "source" | "target",
  ) => {
    const rows = (await fetchAllMock(projectId, fileId, jwt, side)) ?? []
    const filtered = side ? rows.filter((r) => r.side === side) : rows
    await onPage(filtered, true)
  },
  fetchAllFileCells: (...args: unknown[]) =>
    fetchAllMock(...(args as Parameters<typeof fetchAllMock>)),
  fetchCellsByIds: async () => [],
  fetchCellsDelta: async () => ({ rows: [], maxServerSeq: 0 }),
}))

vi.mock("@/lib/sync/cells-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cells-cache")>()
  return {
    ...actual,
    readCellsCache: async () => null,
    writeCellsCache: async () => {},
    resetCellsCacheConnectionForTests: async () => {},
  }
})

import { useCells } from "./useCells"

type LaneCellRow = CellRow & { targetLang?: string }

/** Mirror of useCells.ts laneOf — pins the indistinguishability property. */
function laneOf(r: CellRow): string {
  return (r as LaneCellRow).targetLang ?? ""
}

function makeRow(over: Partial<CellRow> & Pick<CellRow, "cellId" | "side">): CellRow {
  return {
    value: "",
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `e-${over.cellId}-${over.side}`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 0,
    ...over,
  }
}

const getToken = async () => "fake-jwt"

beforeEach(() => {
  fetchAllMock.mockReset()
})

describe("useCells source join — PRE-AQU-1240 default-lane baseline", () => {
  const sourceRow = makeRow({ cellId: "c1", side: "source", value: "Source text" })
  const defaultTargetRow = makeRow({
    cellId: "c1",
    side: "target",
    value: "default-lane translation",
  })
  const namedTargetRow = {
    ...makeRow({
      cellId: "c1",
      side: "target",
      value: "spanish translation",
      eventId: "e-c1-target-es",
    }),
    targetLang: "es",
  } as CellRow

  it("laneOf makes source and default-lane target indistinguishable (both '')", () => {
    expect(laneOf(sourceRow)).toBe("")
    expect(laneOf(defaultTargetRow)).toBe("")
    expect(laneOf(sourceRow)).toBe(laneOf(defaultTargetRow))
    expect(laneOf(namedTargetRow)).toBe("es")
  })

  it("lane='' join admits source + default-lane target as one cell pair", async () => {
    fetchAllMock.mockResolvedValue([sourceRow, defaultTargetRow, namedTargetRow])
    const { result } = renderHook(() =>
      useCells({
        projectId: "proj-join",
        fileId: "file-join",
        getToken,
        enabled: true,
        lane: "",
      }),
    )
    await waitFor(() => expect(result.current.cells.length).toBe(1))
    expect(result.current.cells[0].original).toBe("Source text")
    expect(result.current.cells[0].translated).toBe("default-lane translation")
  })

  it("lane='es' excludes the default-lane target but still pairs with the shared source", async () => {
    fetchAllMock.mockResolvedValue([sourceRow, defaultTargetRow, namedTargetRow])
    const { result } = renderHook(() =>
      useCells({
        projectId: "proj-join-es",
        fileId: "file-join",
        getToken,
        enabled: true,
        lane: "es",
      }),
    )
    await waitFor(() => expect(result.current.cells.length).toBe(1))
    expect(result.current.cells[0].original).toBe("Source text")
    expect(result.current.cells[0].translated).toBe("spanish translation")
  })
})
