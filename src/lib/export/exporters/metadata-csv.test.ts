// Tests for the metadata CSV exporter (FRO-441).
// Verifies column layout, voice name resolution, camera state, and quoting.

import { describe, it, expect } from "vitest"
import { exportMetadataCsv } from "./metadata-csv"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

/** Minimal CellData stub with only the fields the exporter needs. */
function makeCell(overrides: Partial<CellData> & { id: string }): CellData {
  const defaults: Partial<CellData> = {
    fileId: "file-1",
    original: "",
    translated: "",
    context: "",
    group: overrides.group ?? overrides.id,
    type: "text",
    status: "empty",
    validationStatus: "empty",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
  return { ...defaults, ...overrides } as CellData
}

async function toText(blob: Blob): Promise<string> {
  return blob.text()
}

describe("exportMetadataCsv", () => {
  it("produces the correct header", async () => {
    const blob = exportMetadataCsv([])
    const text = await toText(blob)
    expect(text).toBe("cell_ref,voice,camera_state")
  })

  it("emits cell_ref from group when present", async () => {
    const cell = makeCell({ id: "cell-1", group: "GEN 1:1" })
    const text = await toText(exportMetadataCsv([cell]))
    const [, dataRow] = text.split("\r\n")
    expect(dataRow?.startsWith("GEN 1:1,")).toBe(true)
  })

  it("falls back to cell id when group is empty", async () => {
    const cell = makeCell({ id: "cell-xyz", group: "" })
    const text = await toText(exportMetadataCsv([cell]))
    const [, dataRow] = text.split("\r\n")
    expect(dataRow?.startsWith("cell-xyz,")).toBe(true)
  })

  it("resolves voice name from ttsSettings voice library", async () => {
    const settings: ProjectTtsSettings = {
      voices: [{ id: "v1", name: "Narrator" }],
    }
    const cell = makeCell({ id: "c1", group: "GEN 1:1", ttsSettings: { voiceId: "v1" } })
    const text = await toText(exportMetadataCsv([cell], settings))
    const [, dataRow] = text.split("\r\n")
    expect(dataRow).toBe("GEN 1:1,Narrator,")
  })

  it("resolves voice from project castAssignments when no per-cell setting", async () => {
    const settings: ProjectTtsSettings = {
      voices: [{ id: "v2", name: "Jesus" }],
      castAssignments: { "c2": "v2" },
    }
    const cell = makeCell({ id: "c2", group: "MAT 1:1" })
    const text = await toText(exportMetadataCsv([cell], settings))
    const [, dataRow] = text.split("\r\n")
    expect(dataRow).toBe("MAT 1:1,Jesus,")
  })

  it("falls back to voiceId string when voice not in library", async () => {
    const settings: ProjectTtsSettings = { voices: [] }
    const cell = makeCell({ id: "c3", ttsSettings: { voiceId: "unknown-id" } })
    const text = await toText(exportMetadataCsv([cell], settings))
    const [, dataRow] = text.split("\r\n")
    expect(dataRow).toContain(",unknown-id,")
  })

  it("prefers per-cell voiceId over castAssignments", async () => {
    const settings: ProjectTtsSettings = {
      voices: [
        { id: "v-cell", name: "CellVoice" },
        { id: "v-bulk", name: "BulkVoice" },
      ],
      castAssignments: { "c4": "v-bulk" },
    }
    const cell = makeCell({ id: "c4", ttsSettings: { voiceId: "v-cell" } })
    const text = await toText(exportMetadataCsv([cell], settings))
    const [, dataRow] = text.split("\r\n")
    expect(dataRow).toContain(",CellVoice,")
  })

  it("emits camera_state when present", async () => {
    const cell = makeCell({ id: "c5", group: "LUK 1:1", cameraState: "off" })
    const text = await toText(exportMetadataCsv([cell]))
    const [, dataRow] = text.split("\r\n")
    expect(dataRow).toBe("LUK 1:1,,off")
  })

  it("emits empty camera_state when absent", async () => {
    const cell = makeCell({ id: "c6", group: "JHN 1:1" })
    const text = await toText(exportMetadataCsv([cell]))
    const [, dataRow] = text.split("\r\n")
    expect(dataRow).toBe("JHN 1:1,,")
  })

  it("RFC-4180 quotes fields containing commas", async () => {
    const cell = makeCell({ id: "c7", group: "PSA 119:176", ttsSettings: { voiceId: "v-comma" } })
    const settings: ProjectTtsSettings = {
      voices: [{ id: "v-comma", name: "Smith, John" }],
    }
    const text = await toText(exportMetadataCsv([cell], settings))
    const [, dataRow] = text.split("\r\n")
    expect(dataRow).toContain('"Smith, John"')
  })

  it("emits one row per cell in document order", async () => {
    const cells = [
      makeCell({ id: "a", group: "GEN 1:1" }),
      makeCell({ id: "b", group: "GEN 1:2" }),
      makeCell({ id: "c", group: "GEN 1:3" }),
    ]
    const text = await toText(exportMetadataCsv(cells))
    const rows = text.split("\r\n")
    expect(rows).toHaveLength(4) // header + 3 data rows
    expect(rows[1]?.startsWith("GEN 1:1,")).toBe(true)
    expect(rows[2]?.startsWith("GEN 1:2,")).toBe(true)
    expect(rows[3]?.startsWith("GEN 1:3,")).toBe(true)
  })
})
