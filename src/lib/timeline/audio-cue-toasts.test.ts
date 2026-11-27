// Import map X-avtt-paired-count (Nov 2, found by Sam): the finished audio VTT
// import read "Imported 548 audio cues, and paired 648 of them", counting
// pairings, which are many-to-many. It now counts heard lines.
import { describe, expect, it } from "vitest"
import { t } from "@/lib/i18n/standalone"
import { pairedLineCounts } from "./cue-links"

describe("the audio VTT import's finished toast", () => {
  it("counts the heard lines that found a subtitle line, never more than were imported", () => {
    // 548 heard lines; 537 of them paired, some with two subtitle lines each.
    const plans = Array.from({ length: 537 }, (_, i) => ({ textCellId: `s${i}`, cueCellId: `q${i}` }))
      .concat(Array.from({ length: 111 }, (_, i) => ({ textCellId: `s${537 + i}`, cueCellId: `q${i}` })))
    expect(plans).toHaveLength(648)
    const { heardLines } = pairedLineCounts(plans)
    const text = `${t("editor.timeline.audioCuesImported", { count: 548 })} ${t("editor.timeline.audioCuesFoundLines", { count: heardLines })}`
    expect(text).toBe("Imported 548 heard lines. 537 of them found their subtitle lines.")
  })
})
