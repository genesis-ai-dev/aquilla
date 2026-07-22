// Tests for the cells read API wrappers (audit B2).
//
// `streamFileCells` must surface EVERY page's `maxServerSeq` via `onMeta` —
// not just the first page's. The server paginates by offset, so rows can
// shift across page boundaries while a multi-page stream is in flight and a
// cell can be skipped entirely (a torn snapshot). The caller (useCells)
// detects the tear by comparing per-page watermarks; if only the first
// page's were surfaced, a torn stream would be indistinguishable from a
// consistent one and the client would mint a `?since=` cursor that skips
// the lost cell forever.

import { describe, it, expect, vi, afterEach } from "vitest"
import { streamFileCells, fetchFileCells, fetchCellsDelta, fetchCellsByIds } from "./cells-read"
import type { CellRow } from "./cells-read-types"

function makeRow(cellId: string): CellRow {
  return {
    cellId,
    side: "source",
    value: cellId,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `e-${cellId}`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 0,
  }
}

function pageResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("streamFileCells onMeta (B2)", () => {
  it("fires onMeta once per page with that page's maxServerSeq, before the page's rows", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        pageResponse({ cells: [makeRow("a")], nextCursor: "p2", maxServerSeq: 5 }),
      )
      // The event log advanced mid-stream: page 2 reports a newer watermark.
      .mockResolvedValueOnce(
        pageResponse({ cells: [makeRow("c")], nextCursor: null, maxServerSeq: 9 }),
      )
    vi.stubGlobal("fetch", fetchMock)

    const events: Array<{ kind: "meta"; seq: number | null | undefined } | { kind: "page"; ids: string[] }> = []
    await streamFileCells(
      "proj",
      "file",
      "jwt",
      (rows) => {
        events.push({ kind: "page", ids: rows.map((r) => r.cellId) })
      },
      "source",
      (meta) => {
        events.push({ kind: "meta", seq: meta.maxServerSeq })
      },
    )

    expect(events).toEqual([
      { kind: "meta", seq: 5 },
      { kind: "page", ids: ["a"] },
      { kind: "meta", seq: 9 },
      { kind: "page", ids: ["c"] },
    ])
  })

  it("reports an absent watermark (pre-M2-1 server) as undefined on every page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse({ cells: [makeRow("a")], nextCursor: "p2" }))
      .mockResolvedValueOnce(pageResponse({ cells: [makeRow("b")], nextCursor: null }))
    vi.stubGlobal("fetch", fetchMock)

    const metas: Array<number | null | undefined> = []
    await streamFileCells(
      "proj",
      "file",
      "jwt",
      () => {},
      "source",
      (meta) => {
        metas.push(meta.maxServerSeq)
      },
    )
    expect(metas).toEqual([undefined, undefined])
  })
})

describe("AQU-538: lane query param", () => {
  it("fetchFileCells appends lane only when set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse({ cells: [], nextCursor: null, total: 0 }))
      .mockResolvedValueOnce(pageResponse({ cells: [], nextCursor: null, total: 0 }))
    vi.stubGlobal("fetch", fetchMock)

    await fetchFileCells("proj", "file", {}, "jwt")
    expect(fetchMock.mock.calls[0][0] as string).not.toContain("lane=")

    await fetchFileCells("proj", "file", { lane: "fr" }, "jwt")
    expect(fetchMock.mock.calls[1][0] as string).toContain("lane=fr")
  })

  it("fetchCellsDelta appends lane only when set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse({ delta: true, changedCellIds: [], cells: [], maxServerSeq: 1 }))
      .mockResolvedValueOnce(pageResponse({ delta: true, changedCellIds: [], cells: [], maxServerSeq: 1 }))
    vi.stubGlobal("fetch", fetchMock)

    await fetchCellsDelta("proj", "file", 1, "jwt")
    expect(fetchMock.mock.calls[0][0] as string).not.toContain("lane=")

    await fetchCellsDelta("proj", "file", 1, "jwt", "fr")
    expect(fetchMock.mock.calls[1][0] as string).toContain("lane=fr")
  })

  it("fetchCellsByIds appends lane only when set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse({ cells: [], nextCursor: null, total: 0 }))
      .mockResolvedValueOnce(pageResponse({ cells: [], nextCursor: null, total: 0 }))
    vi.stubGlobal("fetch", fetchMock)

    await fetchCellsByIds("proj", "file", ["c1"], "jwt")
    expect(fetchMock.mock.calls[0][0] as string).not.toContain("lane=")

    await fetchCellsByIds("proj", "file", ["c1"], "jwt", "fr")
    expect(fetchMock.mock.calls[1][0] as string).toContain("lane=fr")
  })

  it("fetchCellsByIds batches more than 100 ids without losing or reordering rows", async () => {
    let active = 0
    let maxActive = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const ids = new URL(String(input)).searchParams.get("cellIds")!.split(",")
      await Promise.resolve()
      active -= 1
      return pageResponse({ cells: ids.map(makeRow), nextCursor: null, total: ids.length })
    })
    vi.stubGlobal("fetch", fetchMock)

    const ids = Array.from({ length: 251 }, (_, index) => `c${index}`)
    const rows = await fetchCellsByIds("proj", "file", ids, "jwt")

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(maxActive).toBeLessThanOrEqual(4)
    expect(rows.map((row) => row.cellId)).toEqual(ids)
    expect(fetchMock.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get("cellIds")!.split(",").length,
    )).toEqual([100, 100, 51])
  })

  it("streamFileCells / fetchAllFileCells thread the lane through every page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse({ cells: [makeRow("a")], nextCursor: null, total: 1 }))
    vi.stubGlobal("fetch", fetchMock)

    await streamFileCells("proj", "file", "jwt", () => {}, "target", undefined, "fr")
    expect(fetchMock.mock.calls[0][0] as string).toContain("lane=fr")
  })
})

describe("cells-read metadata passthrough (OBS attachments)", () => {
  it("surfaces an object `metadata` (attachments) on the parsed CellRow", async () => {
    const attachments = [{ type: "image", url: "https://x/01.jpg" }]
    const row = { ...makeRow("frame-01"), metadata: { attachments } }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse({ cells: [row], nextCursor: null, total: 1 }))
    vi.stubGlobal("fetch", fetchMock)

    const page = await fetchFileCells("proj", "file", {}, "jwt")
    // The metadata bucket must pass through unchanged so EditorRow can render
    // OBS frame thumbnails from `metadata.attachments`.
    expect(page.cells[0].metadata).toEqual({ attachments })
  })

  it("parses a `metadata` that arrives as a JSON string into an object", async () => {
    const attachments = [{ type: "image", url: "https://x/01.jpg", alt: "frame 1" }]
    // Some projection paths may not parse the JSONB column — defensively the
    // client must JSON.parse a string-shaped metadata into an object.
    const row = { ...makeRow("frame-02"), metadata: JSON.stringify({ attachments }) }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse({ cells: [row], nextCursor: null, total: 1 }))
    vi.stubGlobal("fetch", fetchMock)

    const page = await fetchFileCells("proj", "file", {}, "jwt")
    expect(page.cells[0].metadata).toEqual({ attachments })
  })

  it("leaves a missing `metadata` untouched (legacy rows)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse({ cells: [makeRow("plain")], nextCursor: null, total: 1 }))
    vi.stubGlobal("fetch", fetchMock)

    const page = await fetchFileCells("proj", "file", {}, "jwt")
    expect(page.cells[0].metadata).toBeUndefined()
  })
})
