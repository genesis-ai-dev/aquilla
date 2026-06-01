import { describe, it, expect } from "vitest"
import { exportVtt } from "./vtt"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "src", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const SETTINGS: ProjectTtsSettings = {
  voices: [{ id: "v-mary", name: "Mary" }],
  castAssignments: { c1: "v-mary" }, // c2 has no explicit assignment
}

async function text(b: Blob) { return b.text() }

describe("exportVtt", () => {
  it("wraps explicitly-cast cells in <v Name> and leaves others plain", async () => {
    const cells = [
      cell({ id: "c1", translated: "Bonjour", startTime: 1, endTime: 2 }),
      cell({ id: "c2", translated: "Salut", startTime: 2, endTime: 3 }),
    ]
    const out = await text(exportVtt(cells, SETTINGS))
    expect(out).toContain("WEBVTT")
    expect(out).toContain("00:00:01.000 --> 00:00:02.000")
    expect(out).toContain("<v Mary>Bonjour</v>")
    expect(out).toContain("Salut")
    expect(out).not.toContain("<v Mary>Salut")
  })

  it("skips cells with no timecodes", async () => {
    const out = await text(exportVtt([cell({ id: "c1", translated: "x" })], SETTINGS))
    expect(out.trim()).toBe("WEBVTT")
  })

  it("falls back to source text when target is empty", async () => {
    const out = await text(exportVtt([cell({ id: "c1", original: "orig", translated: "", startTime: 0, endTime: 1 })], {}))
    expect(out).toContain("orig")
  })
})
