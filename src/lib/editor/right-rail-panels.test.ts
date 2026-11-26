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
  documentPreviewAvailable: false,
  documentPreviewOpen: false,
}

/** Every combination of the eight booleans the rail decides from. */
function allInputs(): RightRailInputs[] {
  const bools = [false, true]
  const out: RightRailInputs[] = []
  for (const inScriptureEditor of bools)
    for (const verseResourcesAvailable of bools)
      for (const whosWhoAvailable of bools)
        for (const parallelBiblesOpen of bools)
          for (const verseResourcesOpen of bools)
            for (const whosWhoOpen of bools)
              for (const documentPreviewAvailable of bools)
                for (const documentPreviewOpen of bools)
                  out.push({
                    inScriptureEditor,
                    verseResourcesAvailable,
                    whosWhoAvailable,
                    parallelBiblesOpen,
                    verseResourcesOpen,
                    whosWhoOpen,
                    documentPreviewAvailable,
                    documentPreviewOpen,
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
        ...(input.documentPreviewAvailable ? ["preview"] : []),
      ]
      expect(computeRightRailSurfaces(input).tabs, JSON.stringify(input)).toEqual(expected)
    }
  })

  it("renders nothing outside the scripture editor when the file has no preview", () => {
    for (const input of allInputs().filter((i) => !i.inScriptureEditor && !i.documentPreviewAvailable)) {
      expect(computeRightRailSurfaces(input)).toEqual({ tabs: [], openPanel: null })
    }
  })

  // A Word or PowerPoint file is rarely scripture: its preview must not wait
  // on the scripture gate, or the files it is for would never be offered it.
  it("offers the document preview alone on a file that is not scripture", () => {
    const input = { ...BASE, inScriptureEditor: false, documentPreviewAvailable: true }
    expect(computeRightRailSurfaces(input)).toEqual({ tabs: ["preview"], openPanel: null })
    expect(computeRightRailSurfaces({ ...input, documentPreviewOpen: true }).openPanel).toBe("preview")
  })

  // The open flag is per project, so it outlives the file it was set on: on a
  // file with no preview there is nothing to render.
  it("never opens the document preview on a file that has none", () => {
    expect(computeRightRailSurfaces({ ...BASE, documentPreviewOpen: true }).openPanel).toBeNull()
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
