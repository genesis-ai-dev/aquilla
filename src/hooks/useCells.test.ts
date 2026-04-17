import "fake-indexeddb/auto"
import { describe, it, expect } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import * as Y from "yjs"
import { useCells } from "./useCells"

function buildDoc(label: string | undefined): Y.Doc {
  const doc = new Y.Doc()
  const cellsMap = doc.getMap("cells")
  const order = doc.getArray<string>("order")
  const yCell = new Y.Map<unknown>()
  yCell.set("id", "c1")
  yCell.set("original", "Hello")
  yCell.set("translatedXml", new Y.XmlFragment())
  yCell.set("history", new Y.Array())
  yCell.set("context", "")
  yCell.set("group", "g")
  yCell.set("type", "text")
  if (label !== undefined) {
    yCell.set("__source", { metadata: { id: "c1", cellLabel: label } })
  }
  cellsMap.set("c1", yCell)
  order.push(["c1"])
  return doc
}

describe("useCells cellLabel surfacing", () => {
  it("returns cellLabel from __source.metadata.cellLabel when present", async () => {
    const doc = buildDoc("Narrator")
    const { result } = renderHook(() => useCells(doc))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].cellLabel).toBe("Narrator")
  })

  it("returns undefined cellLabel when __source is absent", async () => {
    const doc = buildDoc(undefined)
    const { result } = renderHook(() => useCells(doc))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].cellLabel).toBeUndefined()
  })
})
