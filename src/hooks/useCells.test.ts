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
    const { result } = renderHook(() => useCells(doc, "test-file"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].cellLabel).toBe("Narrator")
  })

  it("returns undefined cellLabel when __source is absent", async () => {
    const doc = buildDoc(undefined)
    const { result } = renderHook(() => useCells(doc, "test-file"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].cellLabel).toBeUndefined()
  })
})

describe("useCells paired source/target docs", () => {
  function makeSourceDoc(): Y.Doc {
    const doc = new Y.Doc()
    const cellsMap = doc.getMap("cells")
    const order = doc.getArray<string>("order")
    const sCell = new Y.Map<unknown>()
    sCell.set("id", "c1")
    sCell.set("original", "In the beginning")
    sCell.set("originalHtml", "<em>In the beginning</em>")
    sCell.set("context", "GEN 1:1")
    sCell.set("group", "GEN")
    sCell.set("section", "GEN 1")
    sCell.set("type", "text")
    cellsMap.set("c1", sCell)
    order.push(["c1"])
    return doc
  }

  function makeTargetDoc(seedTranslation: string): Y.Doc {
    const doc = new Y.Doc()
    const cellsMap = doc.getMap("cells")
    const order = doc.getArray<string>("order")
    const tCell = new Y.Map<unknown>()
    tCell.set("id", "c1")
    const frag = new Y.XmlFragment()
    tCell.set("translatedXml", frag)
    tCell.set("history", new Y.Array())
    cellsMap.set("c1", tCell)
    order.push(["c1"])
    if (seedTranslation) {
      frag.insert(0, [new Y.XmlText(seedTranslation)])
    }
    return doc
  }

  it("joins source-side fields from sourceDoc when paired", async () => {
    const sourceDoc = makeSourceDoc()
    const targetDoc = makeTargetDoc("")
    const { result } = renderHook(() =>
      useCells(targetDoc, "target-file", "u", 1, sourceDoc),
    )
    await waitFor(() => expect(result.current).toHaveLength(1))
    const cell = result.current[0]
    expect(cell.original).toBe("In the beginning")
    expect(cell.originalHtml).toBe("<em>In the beginning</em>")
    expect(cell.context).toBe("GEN 1:1")
    expect(cell.section).toBe("GEN 1")
    expect(cell.translated).toBe("")
    expect(cell.fileId).toBe("target-file")
  })

  it("falls back to single-doc reads when sourceDoc is null (legacy)", async () => {
    const doc = buildDoc(undefined)
    doc.getMap("cells").get("c1") // smoke
    const { result } = renderHook(() => useCells(doc, "legacy", "u", 1, null))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].original).toBe("Hello")
  })
})
