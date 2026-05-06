import "fake-indexeddb/auto"
import { describe, it, expect } from "vitest"
import { render, act, waitFor } from "@testing-library/react"
import * as Y from "yjs"
import { useCells, type CellData } from "./useCells"
import type { CellAuditStats } from "./useCellsAuditStats"

function setupCell(doc: Y.Doc, id: string, plain = "hello") {
  const cellsMap = doc.getMap("cells")
  const order = doc.getArray<string>("order")
  const cell = new Y.Map<unknown>()
  cell.set("id", id)
  cell.set("original", "")
  cell.set("context", "")
  cell.set("group", "")
  cell.set("type", "text")
  const frag = new Y.XmlFragment()
  const p = new Y.XmlElement("p")
  p.insert(0, [new Y.XmlText(plain)])
  frag.insert(0, [p])
  cell.set("translatedXml", frag)
  cellsMap.set(id, cell)
  order.push([id])
}

function makeStats(
  cellId: string,
  partial: Partial<CellAuditStats> = {},
): CellAuditStats {
  return {
    cellId,
    editCount: 1,
    contentHash: "hash",
    lastEditAt: 1000,
    lastEditEventId: "ev-cur",
    activeValidators: [],
    ...partial,
  }
}

function Probe({
  doc,
  username,
  required,
  stats,
  out,
}: {
  doc: Y.Doc
  username: string
  required: number
  stats?: ReadonlyMap<string, CellAuditStats>
  out: { current?: CellData[] }
}) {
  const cells = useCells(doc, "test-file", username, required, stats)
  out.current = cells
  return null
}

describe("useCells — validation derivation from D1 audit stats", () => {
  it("uses stats.activeValidators in preference to Y.Doc walk", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")

    const stats = new Map([
      ["c1", makeStats("c1", { activeValidators: ["alice"] })],
    ])
    const out: { current?: CellData[] } = {}
    render(
      <Probe doc={doc} username="alice" required={2} stats={stats} out={out} />,
    )
    await waitFor(() => expect(out.current).toHaveLength(1))
    expect(out.current![0].validationStatus).toBe("self")
    expect(out.current![0].activeValidators).toEqual(["alice"])
  })

  it("'full' wins over 'self' when validator count meets threshold", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")

    const stats = new Map([
      ["c1", makeStats("c1", { activeValidators: ["alice", "bob"] })],
    ])
    const out: { current?: CellData[] } = {}
    render(
      <Probe doc={doc} username="alice" required={2} stats={stats} out={out} />,
    )
    await waitFor(() => expect(out.current).toHaveLength(1))
    expect(out.current![0].validationStatus).toBe("full")
  })

  it("'others' when only non-current users have validated", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")

    const stats = new Map([
      ["c1", makeStats("c1", { activeValidators: ["bob"] })],
    ])
    const out: { current?: CellData[] } = {}
    render(
      <Probe doc={doc} username="alice" required={2} stats={stats} out={out} />,
    )
    await waitFor(() => expect(out.current).toHaveLength(1))
    expect(out.current![0].validationStatus).toBe("others")
    expect(out.current![0].activeValidators).toEqual(["bob"])
  })

  it("'none' when stats present but no active validators on the current edit", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")

    const stats = new Map([
      ["c1", makeStats("c1", { activeValidators: [] })],
    ])
    const out: { current?: CellData[] } = {}
    render(
      <Probe doc={doc} username="alice" required={1} stats={stats} out={out} />,
    )
    await waitFor(() => expect(out.current).toHaveLength(1))
    expect(out.current![0].validationStatus).toBe("none")
  })

  it("'empty' takes precedence when translated text is blank, even if stats lists validators", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1", "")

    const stats = new Map([
      ["c1", makeStats("c1", { activeValidators: ["alice"] })],
    ])
    const out: { current?: CellData[] } = {}
    render(
      <Probe doc={doc} username="alice" required={1} stats={stats} out={out} />,
    )
    await waitFor(() => expect(out.current).toHaveLength(1))
    expect(out.current![0].validationStatus).toBe("empty")
    expect(out.current![0].activeValidators).toEqual([])
  })

  it("re-derives when the stats map changes (validator added)", async () => {
    const doc = new Y.Doc()
    setupCell(doc, "c1")
    setupCell(doc, "c2")

    const out: { current?: CellData[] } = {}
    const stats1 = new Map([
      ["c1", makeStats("c1", { activeValidators: [] })],
      ["c2", makeStats("c2", { activeValidators: ["bob"] })],
    ])
    const { rerender } = render(
      <Probe
        doc={doc}
        username="alice"
        required={2}
        stats={stats1}
        out={out}
      />,
    )
    await waitFor(() => expect(out.current).toHaveLength(2))
    expect(out.current!.find((c) => c.id === "c1")!.validationStatus).toBe("none")

    const c1Before = out.current!.find((c) => c.id === "c1")!
    const c2Before = out.current!.find((c) => c.id === "c2")!

    // Only c1's stats change; c2's must keep its referentially stable CellData.
    const stats2 = new Map([
      ["c1", makeStats("c1", { activeValidators: ["alice"] })],
      ["c2", makeStats("c2", { activeValidators: ["bob"] })],
    ])
    act(() => {
      rerender(
        <Probe
          doc={doc}
          username="alice"
          required={2}
          stats={stats2}
          out={out}
        />,
      )
    })
    await waitFor(() => {
      expect(out.current!.find((c) => c.id === "c1")!.validationStatus).toBe(
        "self",
      )
    })
    const c2After = out.current!.find((c) => c.id === "c2")!
    expect(c2After).toBe(c2Before) // same ref — React.memo would skip
    expect(out.current!.find((c) => c.id === "c1")!).not.toBe(c1Before)
  })
})
