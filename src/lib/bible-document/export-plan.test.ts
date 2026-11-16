// AQU-2559: the live export preview is only worth showing if it is the file
// the server would send. The server builds its plan from SQL
// (sync-worker/src/events/usfm-export-plan.ts); this builds it from the cells
// on screen. Each case below is one rule the two must agree on.

import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { buildClientUsfmPlan, parsePreviewSource, renderUsfmPreview } from "./export-plan"

const RAW = "\\id GEN\n\\c 1\n\\p\n\\v 1 In the beginning.\n\\p\n\\v 2 The earth.\n\\v 3 And God said.\n\\v 4 And it was so.\n"

function cell(id: string, ref: string | null, translated: string, extra: Partial<CellData> = {}): CellData {
  return { id, fileId: "f1", globalReferences: ref ? [ref] : [], translated, original: "", ...extra } as CellData
}

const added = { metadata: { aquillaOrigin: { kind: "user-insert", version: 1 } } } as Partial<CellData>

describe("client USFM export plan", () => {
  it("produces the file the export route produces for the same cells", () => {
    const cells = [
      cell("v1", "GEN 1:1", "Au commencement."),
      cell("a1", null, "Une ligne ajoutée.", added),
      cell("a2", null, "", added),
      cell("v2", "GEN 1:2", "La terre.", { hidden: true }),
      cell("v3", "GEN 1:3", ""),
      cell("v4", "GEN 1:4", "Et cela fut."),
    ]
    const preview = renderUsfmPreview(parsePreviewSource(RAW), buildClientUsfmPlan(cells, ["GEN 1:4"]))
    // Verse 1 translated with its added line inside it; verse 2 hidden and
    // verse 4 removed, markers included; verse 3 keeps the source's words.
    expect(preview.text).toBe("\\id GEN\n\\c 1\n\\p\n\\v 1 Au commencement. Une ligne ajoutée.\n\\p\n\\v 3 And God said.\n")
    expect([preview.translated, preview.total]).toEqual([1, 2])
  })

  it("shows words that are typed but not saved yet", () => {
    const cells = [cell("v1", "GEN 1:1", "Au commencement."), cell("v3", "GEN 1:3", "")]
    const plan = buildClientUsfmPlan(cells, [], new Map([["v3", "\\p\nDieu dit."]]))
    expect(renderUsfmPreview(parsePreviewSource(RAW), plan).text).toContain("\\v 2 The earth.\n\\p\n\\v 3 Dieu dit.\n")
  })

  it("puts back the notes an agent import parked beside the verse", () => {
    const note = { kind: "footnote", caller: "+", ref: "1:1", text: "note", raw: "\\f + \\fr 1:1 \\ft note\\f*" }
    const cells = [cell("v1", "GEN 1:1", "Au commencement.", { metadata: { usfmNotes: [note] } } as Partial<CellData>)]
    expect(buildClientUsfmPlan(cells).overrides.get("GEN 1:1")).toBe("Au commencement. \\f + \\fr 1:1 \\ft note\\f*")
  })
})
