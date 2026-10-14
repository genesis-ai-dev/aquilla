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
  whosWhoAvailable: true,
  parallelBiblesOpen: false,
  verseResourcesOpen: false,
  whosWhoOpen: false,
}

/** Every combination of the six booleans the rail decides from. */
function allInputs(): RightRailInputs[] {
  const bools = [false, true]
  const out: RightRailInputs[] = []
  for (const inScriptureEditor of bools)
    for (const verseResourcesAvailable of bools)
      for (const whosWhoAvailable of bools)
        for (const parallelBiblesOpen of bools)
          for (const verseResourcesOpen of bools)
            for (const whosWhoOpen of bools)
              out.push({
                inScriptureEditor,
                verseResourcesAvailable,
                whosWhoAvailable,
                parallelBiblesOpen,
                verseResourcesOpen,
                whosWhoOpen,
              })
  return out
}

const NOTHING = {
  biblesPanel: false,
  biblesEdge: false,
  resourcesPanel: false,
  resourcesEdge: false,
  peoplePanel: false,
  peopleEdge: false,
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
      expect(s.peoplePanel && s.peopleEdge, `people: ${JSON.stringify(input)}`).toBe(false)
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

  // AQU-1689: the same reachability for Who's Who, whose "People" edge tab is
  // the way back after the panel's X.
  it("always offers exactly one Who's Who surface when the enrichment is on", () => {
    for (const input of allInputs().filter((i) => i.inScriptureEditor && i.whosWhoAvailable)) {
      const s = computeRightRailSurfaces(input)
      expect(s.peoplePanel !== s.peopleEdge, JSON.stringify(input)).toBe(true)
    }
  })

  it("renders nothing outside the scripture editor", () => {
    for (const input of allInputs().filter((i) => !i.inScriptureEditor)) {
      expect(computeRightRailSurfaces(input)).toEqual(NOTHING)
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

  // AQU-1689: Who's Who off (or Bible data off) means no panel and no tab.
  it("renders neither Who's Who surface when the enrichment is off", () => {
    for (const input of allInputs().filter((i) => !i.whosWhoAvailable)) {
      const s = computeRightRailSurfaces(input)
      expect(s.peoplePanel, JSON.stringify(input)).toBe(false)
      expect(s.peopleEdge, JSON.stringify(input)).toBe(false)
    }
  })

  it("shows every edge tab when every panel is closed", () => {
    expect(computeRightRailSurfaces(BASE)).toEqual({
      biblesPanel: false,
      biblesEdge: true,
      resourcesPanel: false,
      resourcesEdge: true,
      peoplePanel: false,
      peopleEdge: true,
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
      peoplePanel: false,
      peopleEdge: true,
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
      peoplePanel: false,
      peopleEdge: true,
    })

    // The X on Parallel Bibles flips only its own flag.
    expect(computeRightRailSurfaces({ ...BASE, verseResourcesOpen: true })).toEqual(helpsOpen)
    // Opening Who's Who leaves the other two as they were.
    expect(computeRightRailSurfaces({ ...BASE, verseResourcesOpen: true, whosWhoOpen: true })).toEqual({
      ...helpsOpen,
      peoplePanel: true,
      peopleEdge: false,
    })
  })
})

describe("hasRightRailPanel / hasRightRailEdge", () => {
  it("agree with the surfaces they summarize", () => {
    for (const input of allInputs()) {
      const s = computeRightRailSurfaces(input)
      expect(hasRightRailPanel(s)).toBe(s.biblesPanel || s.resourcesPanel || s.peoplePanel)
      expect(hasRightRailEdge(s)).toBe(s.biblesEdge || s.resourcesEdge || s.peopleEdge)
    }
  })

  it("reports no edge tabs once every panel is open", () => {
    const s = computeRightRailSurfaces({
      ...BASE,
      parallelBiblesOpen: true,
      verseResourcesOpen: true,
      whosWhoOpen: true,
    })
    expect(hasRightRailEdge(s)).toBe(false)
    expect(hasRightRailPanel(s)).toBe(true)
  })

  it("still has a panel to render when only Who's Who is open", () => {
    const s = computeRightRailSurfaces({ ...BASE, whosWhoOpen: true })
    expect(hasRightRailPanel(s)).toBe(true)
  })
})
