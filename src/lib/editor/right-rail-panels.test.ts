import { describe, expect, it } from "vitest"
import {
  computeRightRailSurfaces,
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

describe("computeRightRailSurfaces", () => {
  // The rail switches between panels like tabs. Several open side by side is
  // what this replaced (and, before AQU-1316, duplicate Bibles panels).
  it("never opens more than one panel, and only one that has a button", () => {
    for (const input of allInputs()) {
      const s = computeRightRailSurfaces(input)
      if (s.openPanel !== null) {
        expect(s.tabs, JSON.stringify(input)).toContain(s.openPanel)
      }
    }
  })

  // Each feature stays reachable: its button stays in the rail while its
  // panel is open, so there is always a way to switch to it or close it.
  it("offers every available feature's button whatever is open", () => {
    for (const input of allInputs().filter((i) => i.inScriptureEditor)) {
      const expected = [
        "bibles",
        ...(input.verseResourcesAvailable ? ["resources"] : []),
        ...(input.whosWhoAvailable ? ["people"] : []),
      ]
      expect(computeRightRailSurfaces(input).tabs, JSON.stringify(input)).toEqual(expected)
    }
  })

  it("renders nothing outside the scripture editor", () => {
    for (const input of allInputs().filter((i) => !i.inScriptureEditor)) {
      expect(computeRightRailSurfaces(input)).toEqual({ tabs: [], openPanel: null })
    }
  })

  // AQU-461 / AQU-1689: a gated-off feature cannot be open, even if its
  // persisted flag says so — its routes would only ever show an error.
  it("never opens a feature whose gate is off", () => {
    expect(
      computeRightRailSurfaces({ ...BASE, verseResourcesAvailable: false, verseResourcesOpen: true })
        .openPanel,
    ).toBeNull()
    expect(
      computeRightRailSurfaces({ ...BASE, whosWhoAvailable: false, whosWhoOpen: true }).openPanel,
    ).toBeNull()
  })

  // Older sessions persisted the three flags independently; the first in rail
  // order wins rather than showing several.
  it("picks the first open flag in rail order when several are set", () => {
    expect(
      computeRightRailSurfaces({ ...BASE, verseResourcesOpen: true, whosWhoOpen: true }).openPanel,
    ).toBe("resources")
    expect(
      computeRightRailSurfaces({
        ...BASE,
        parallelBiblesOpen: true,
        verseResourcesOpen: true,
        whosWhoOpen: true,
      }).openPanel,
    ).toBe("bibles")
  })
})
