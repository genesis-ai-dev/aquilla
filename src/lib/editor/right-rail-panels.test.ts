import { describe, expect, it } from "vitest"
import {
  computeRightRailSurfaces,
  hasRightRailEdge,
  hasRightRailPanel,
  type RightRailInputs,
} from "./right-rail-panels"

const BASE: RightRailInputs = {
  inScriptureEditor: true,
  verseResourcesAvailable: true,
  parallelBiblesOpen: false,
  verseResourcesOpen: false,
}

/** Every combination of the four booleans the rail decides from. */
function allInputs(): RightRailInputs[] {
  const bools = [false, true]
  const out: RightRailInputs[] = []
  for (const inScriptureEditor of bools)
    for (const verseResourcesAvailable of bools)
      for (const parallelBiblesOpen of bools)
        for (const verseResourcesOpen of bools)
          out.push({
            inScriptureEditor,
            verseResourcesAvailable,
            parallelBiblesOpen,
            verseResourcesOpen,
          })
  return out
}

describe("computeRightRailSurfaces", () => {
  // AQU-1316 AC3: the duplicate-panel guard. The report saw up to three
  // Parallel Bibles panels side by side; this is the property that makes that
  // unrepresentable, checked exhaustively rather than on the paths we thought of.
  it("never renders a feature's panel and its edge tab at the same time", () => {
    for (const input of allInputs()) {
      const s = computeRightRailSurfaces(input)
      expect(s.biblesPanel && s.biblesEdge, `bibles: ${JSON.stringify(input)}`).toBe(false)
      expect(s.resourcesPanel && s.resourcesEdge, `resources: ${JSON.stringify(input)}`).toBe(false)
    }
  })

  // The other half of the same invariant: inside the editor a feature is always
  // reachable. Without this, closing a panel could strand it with no edge tab to
  // reopen from — the "stays open until a full page reload" half of the report,
  // inverted.
  it("always offers exactly one Parallel Bibles surface inside the scripture editor", () => {
    for (const input of allInputs().filter((i) => i.inScriptureEditor)) {
      const s = computeRightRailSurfaces(input)
      expect(s.biblesPanel !== s.biblesEdge, JSON.stringify(input)).toBe(true)
    }
  })

  it("always offers exactly one Verse Resources surface when the project gate is on", () => {
    for (const input of allInputs().filter(
      (i) => i.inScriptureEditor && i.verseResourcesAvailable,
    )) {
      const s = computeRightRailSurfaces(input)
      expect(s.resourcesPanel !== s.resourcesEdge, JSON.stringify(input)).toBe(true)
    }
  })

  it("renders nothing outside the scripture editor", () => {
    for (const input of allInputs().filter((i) => !i.inScriptureEditor)) {
      expect(computeRightRailSurfaces(input)).toEqual({
        biblesPanel: false,
        biblesEdge: false,
        resourcesPanel: false,
        resourcesEdge: false,
      })
    }
  })

  // AQU-461: the aquifer routes 404 when the project's Bible-resources gate is
  // off, so an ungated tab would only ever show an error.
  it("renders neither Verse Resources surface when the project gate is off", () => {
    for (const input of allInputs().filter((i) => !i.verseResourcesAvailable)) {
      const s = computeRightRailSurfaces(input)
      expect(s.resourcesPanel, JSON.stringify(input)).toBe(false)
      expect(s.resourcesEdge, JSON.stringify(input)).toBe(false)
    }
  })

  it("shows both edge tabs when both panels are closed", () => {
    expect(computeRightRailSurfaces(BASE)).toEqual({
      biblesPanel: false,
      biblesEdge: true,
      resourcesPanel: false,
      resourcesEdge: true,
    })
  })

  // AQU-1316 AC1/AC2, as the reporter walked it: open Helps, open Bibles, then
  // close Bibles from the panel's X. Closing must give back the edge tab and
  // must not disturb the other feature.
  it("swaps a feature's panel for its edge tab as its open flag flips, independently", () => {
    const helpsOpen = computeRightRailSurfaces({ ...BASE, verseResourcesOpen: true })
    expect(helpsOpen).toEqual({
      biblesPanel: false,
      biblesEdge: true,
      resourcesPanel: true,
      resourcesEdge: false,
    })

    const bothOpen = computeRightRailSurfaces({
      ...BASE,
      verseResourcesOpen: true,
      parallelBiblesOpen: true,
    })
    expect(bothOpen).toEqual({
      biblesPanel: true,
      biblesEdge: false,
      resourcesPanel: true,
      resourcesEdge: false,
    })

    // The X on Parallel Bibles flips only its own flag.
    expect(computeRightRailSurfaces({ ...BASE, verseResourcesOpen: true })).toEqual(helpsOpen)
  })
})

describe("hasRightRailPanel / hasRightRailEdge", () => {
  it("agree with the surfaces they summarize", () => {
    for (const input of allInputs()) {
      const s = computeRightRailSurfaces(input)
      expect(hasRightRailPanel(s)).toBe(s.biblesPanel || s.resourcesPanel)
      expect(hasRightRailEdge(s)).toBe(s.biblesEdge || s.resourcesEdge)
    }
  })

  it("reports no edge tabs once both panels are open", () => {
    const s = computeRightRailSurfaces({
      ...BASE,
      parallelBiblesOpen: true,
      verseResourcesOpen: true,
    })
    expect(hasRightRailEdge(s)).toBe(false)
    expect(hasRightRailPanel(s)).toBe(true)
  })
})
