import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import {
  __resetCellDisplayFieldsCache,
  displayFieldLabel,
  displayFieldValue,
  getCellDisplayFields,
  setCellDisplayField,
  useCellDisplayFields,
} from "./cell-display-fields"

describe("cell-display-fields (AQU-1369)", () => {
  beforeEach(() => {
    localStorage.clear()
    __resetCellDisplayFieldsCache()
  })

  it("is empty for a project that never switched a field on", () => {
    expect(getCellDisplayFields("p1")).toEqual([])
  })

  it("scopes a field to its project, not to other projects", () => {
    setCellDisplayField("p1", "Field", true)
    expect(getCellDisplayFields("p1")).toEqual(["Field"])
    expect(getCellDisplayFields("p2")).toEqual([])
  })

  it("switches off with the same call from anywhere, clearing the project", () => {
    setCellDisplayField("p1", "Field", true)
    setCellDisplayField("p1", "Field", false)
    expect(getCellDisplayFields("p1")).toEqual([])
  })

  it("persists across sessions (a fresh cache rereads storage)", () => {
    setCellDisplayField("p1", "Field", true)
    setCellDisplayField("p1", "domain", true)
    __resetCellDisplayFieldsCache()
    expect(getCellDisplayFields("p1")).toEqual(["Field", "domain"])
  })

  it("does not duplicate a field switched on twice", () => {
    setCellDisplayField("p1", "Field", true)
    setCellDisplayField("p1", "Field", true)
    expect(getCellDisplayFields("p1")).toEqual(["Field"])
  })

  it("survives corrupt storage by reading as empty", () => {
    localStorage.setItem("aq.cell-display-fields.v1", "{not json")
    expect(getCellDisplayFields("p1")).toEqual([])
  })

  it("re-renders every subscriber when a field is toggled", () => {
    const a = renderHook(() => useCellDisplayFields("p1"))
    const b = renderHook(() => useCellDisplayFields("p1"))
    act(() => setCellDisplayField("p1", "Field", true))
    expect(a.result.current).toEqual(["Field"])
    expect(b.result.current).toEqual(["Field"])
  })
})

describe("displayFieldLabel", () => {
  it("labels scalars", () => {
    expect(displayFieldLabel("glosses")).toBe("glosses")
    expect(displayFieldLabel(3)).toBe("3")
    expect(displayFieldLabel(false)).toBe("false")
  })

  it("joins a flat list of scalars", () => {
    expect(displayFieldLabel(["a", "b"])).toBe("a, b")
  })

  it("gives no label to empty, nested, or object values", () => {
    expect(displayFieldLabel("  ")).toBeNull()
    expect(displayFieldLabel([])).toBeNull()
    expect(displayFieldLabel(null)).toBeNull()
    expect(displayFieldLabel({ a: 1 })).toBeNull()
    expect(displayFieldLabel([["a"]])).toBeNull()
    expect(displayFieldLabel([{ url: "https://x" }])).toBeNull()
  })
})

describe("displayFieldValue", () => {
  // WHY: importers namespace their fields (SDBH writes `metadata.sdbh.lemma`),
  // so a switched-on key must reach one level down or those cells never label.
  it("reads a top-level key", () => {
    expect(displayFieldValue({ quote: "λόγος" }, "quote")).toBe("λόγος")
  })

  it("reads a parent.child key one level down", () => {
    expect(displayFieldValue({ sdbh: { lemma: "אָב" } }, "sdbh.lemma")).toBe("אָב")
  })

  it("prefers an exact top-level key that contains a dot", () => {
    expect(displayFieldValue({ "a.b": "flat", a: { b: "nested" } }, "a.b")).toBe("flat")
  })

  it("is undefined when the cell doesn't carry the key", () => {
    expect(displayFieldValue(null, "sdbh.lemma")).toBeUndefined()
    expect(displayFieldValue({ quote: "x" }, "sdbh.lemma")).toBeUndefined()
    expect(displayFieldValue({ sdbh: ["lemma"] }, "sdbh.0")).toBeUndefined()
    expect(displayFieldValue({ sdbh: { lemma: "x" } }, "sdbh.toString")).toBeUndefined()
  })
})
