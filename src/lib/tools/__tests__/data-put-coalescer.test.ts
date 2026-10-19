// AQU-1937: data.put calls fired together are coalesced into one putMany per
// (namespace, collection); each caller still resolves or rejects on its own.

import { describe, expect, it, vi } from "vitest"
import { createDataPutCoalescer } from "../data-put-coalescer"
import { createFilesHandlers, type ToolFilesHostData } from "../host-handlers-files"

function target() {
  const dataPut = vi.fn(async (_ns: string, _coll: string, id: string, _doc: unknown, anchor: { cellId: string } | null) => {
    if (anchor?.cellId === "missing") throw new Error("the anchor cell does not exist")
    return { id, version: `single:${id}` }
  })
  const dataPutMany = vi.fn(async (_ns: string, _coll: string, items: Array<{ id: string; anchor: { cellId: string } | null }>) => {
    if (items.some((it) => it.anchor?.cellId === "missing")) throw new Error("items[?]: the anchor cell does not exist")
    return items.map((it) => ({ id: it.id, version: `many:${it.id}` }))
  })
  return { dataPut, dataPutMany }
}

describe("data.put coalescing", () => {
  it("sends puts fired together for one (ns, coll) as ONE putMany, in order, each caller getting its own result", async () => {
    const t = target()
    const put = createDataPutCoalescer(t)
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => put("door43.alignment", "tit", `TIT 1:${i + 1}`, { n: i }, null)))
    expect(t.dataPutMany).toHaveBeenCalledTimes(1)
    expect(t.dataPut).not.toHaveBeenCalled()
    expect(t.dataPutMany.mock.calls[0][2].map((it) => it.id)).toEqual(Array.from({ length: 50 }, (_, i) => `TIT 1:${i + 1}`))
    expect(results[7]).toEqual({ id: "TIT 1:8", version: "many:TIT 1:8" })
  })

  it("keeps collections apart and leaves a lone put as a single put", async () => {
    const t = target()
    const put = createDataPutCoalescer(t)
    await Promise.all([put("ns", "a", "1", 1, null), put("ns", "a", "2", 2, null), put("ns", "b", "3", 3, null)])
    expect(t.dataPutMany).toHaveBeenCalledTimes(1)
    expect(t.dataPutMany.mock.calls[0][1]).toBe("a")
    expect(t.dataPut).toHaveBeenCalledTimes(1)
    expect(t.dataPut.mock.calls[0][1]).toBe("b")
  })

  it("rejects only the bad record when the batch fails (the others still land)", async () => {
    const t = target()
    const put = createDataPutCoalescer(t)
    const settled = await Promise.allSettled([
      put("ns", "c", "ok-1", 1, { cellId: "c1" } as never),
      put("ns", "c", "bad", 2, { cellId: "missing" } as never),
      put("ns", "c", "ok-2", 3, { cellId: "c2" } as never),
    ])
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "fulfilled"])
    expect((settled[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error)
    expect(t.dataPut).toHaveBeenCalledTimes(3)
  })

  it("keeps write order when the same record is put twice in one window", async () => {
    const t = target()
    const put = createDataPutCoalescer(t)
    await Promise.all([put("ns", "d", "x", 1, null), put("ns", "d", "y", 1, null), put("ns", "d", "x", 2, null)])
    // First window [x, y], then [x] alone.
    expect(t.dataPutMany.mock.calls[0][2].map((it) => it.id)).toEqual(["x", "y"])
    expect(t.dataPut.mock.calls.map((c) => [c[2], c[3]])).toEqual([["x", 2]])
  })

  it("is what the bridge's data.put handler uses", async () => {
    const t = target()
    const handlers = createFilesHandlers(t as unknown as ToolFilesHostData)
    const out = await Promise.all([0, 1, 2].map((i) => handlers["data.put"]({ ns: "e2e", id: `r${i}`, doc: { i } })))
    expect(t.dataPutMany).toHaveBeenCalledTimes(1)
    expect(out).toEqual([0, 1, 2].map((i) => ({ id: `r${i}`, version: `many:r${i}` })))
  })
})
