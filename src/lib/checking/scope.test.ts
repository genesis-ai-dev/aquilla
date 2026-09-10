import { describe, it, expect } from "vitest"
import { checkingUnitKey, selectedUnits, selectionState, toggleUnits, sectionForRef, checkingLabel } from "./scope"

describe("checking scope", () => {
  it("shows useful labels instead of internal UUIDs", () => {
    expect(checkingLabel("c5b1a330-7d95-413d-a136-2f050dc4bdaf", 2)).toBe("Unit 3")
    expect(checkingLabel("MRK 1:1", 0)).toBe("MRK 1:1")
  })
  const units = [{ fileId: "a", cellId: "1" }, { fileId: "a", cellId: "2" }]
  it("selects and deselects a hierarchy without touching another file", () => {
    const other = checkingUnitKey({ fileId: "b", cellId: "1" })
    const selected = toggleUnits(units, new Set([other]), true)
    expect(selectionState(units, selected)).toEqual({ checked: true, indeterminate: false })
    expect(toggleUnits(units, selected, false)).toEqual(new Set([other]))
    selected.delete(checkingUnitKey(units[0]))
    expect(selectionState(units, selected)).toEqual({ checked: false, indeterminate: true })
  })
  it("serializes only selected units in file order, without including future units", () => {
    const files = [{ fileId: "a", name: "Genesis", units: [
      { cellId: "2", label: "GEN 1:2", section: "GEN 1" },
      { cellId: "1", label: "GEN 1:1", section: "GEN 1" },
    ] }]
    expect(selectedUnits(files, new Set([checkingUnitKey(units[0])]))).toEqual([units[0]])
    expect(sectionForRef("GEN 1:2")).toBe("GEN 1")
    expect(sectionForRef(null)).toBe("Units")
  })
})
