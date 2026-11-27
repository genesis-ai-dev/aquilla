// Import map D#23 (Nov 8): the film and import strings say "1 cue", not "1 cues".
import { describe, expect, it } from "vitest"
import { t } from "./standalone"

describe("film and import counts take their plural forms", () => {
  it("one", () => {
    expect(t("editor.timeline.subtitleSourceImportCues", { count: 1 })).toBe("Extract 1 cue")
    expect(t("editor.timeline.audioVttImportCues", { count: 1 })).toBe("Import 1 cue")
    expect(t("editor.timeline.audioVttDroppedCues", { count: 1 })).toBe("1 line carried no usable text and was skipped.")
    expect(t("editor.timeline.charactersAssignedLeadSubtitle", { count: 1 })).toBe("1 line gets a character")
    expect(t("importExport.scriptAlignment.overwrite", { count: 1 })).toBe("1 segment in this track will be overwritten.")
  })
  it("many", () => {
    expect(t("editor.timeline.subtitleSourceImportCues", { count: 39 })).toBe("Extract 39 cues")
    expect(t("editor.timeline.audioVttCueSummary", { count: 3, span: "0:01–0:18" })).toBe("3 cues, 0:01–0:18")
  })
})
