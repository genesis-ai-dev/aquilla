// AQU-2045: the analysis reads a row made from a recording by its transcript,
// not the recording's file name every such row stores.
import { describe, expect, it, vi } from "vitest"

const rows = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }))
vi.mock("@/lib/sync/cells-read", () => ({
  fetchAllFileCells: async () => rows.value,
}))

import { buildSourceLoader } from "./load-file-sources"

const file = { fileId: "f1", name: "Speech film" }

describe("buildSourceLoader", () => {
  it("reads a text row's value and a recording row's transcript", async () => {
    rows.value = [
      { cellId: "t1", value: "In the beginning was the Word." },
      { cellId: "m1", value: "speech.webm", medium: "media", transcription: "Amen." },
      { cellId: "m2", value: "speech.webm", medium: "media", transcription: null },
      { cellId: "m3", value: "speech.webm", medium: "media" },
    ]
    const load = buildSourceLoader("p1", async () => "token")
    expect(await load(file)).toEqual(["In the beginning was the Word.", "Amen.", "", ""])
  })
})
