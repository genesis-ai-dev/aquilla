import { describe, it, expect } from "vitest"
import { exportPlainTextDump } from "./plain-text-dump"
import type { CellData } from "@/hooks/useCells"

function makeCell(overrides: Partial<CellData>): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "Hello world",
    translated: "Bonjour monde",
    context: "",
    group: "GEN 1:1",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

const CELLS: CellData[] = [
  makeCell({ id: "c1", group: "GEN 1:1", original: "In the beginning", translated: "Au commencement" }),
  makeCell({ id: "c2", group: "GEN 1:2", original: "The earth was formless", translated: "La terre était informe" }),
  makeCell({ id: "c3", group: "GEN 1:3", original: "God said", translated: "" }), // untranslated
]

async function blobText(blob: Blob): Promise<string> {
  return blob.text()
}

describe("exportPlainTextDump", () => {
  it("emits only non-empty translated segments, one per line", async () => {
    const blob = exportPlainTextDump(CELLS)
    const text = await blobText(blob)
    const lines = text.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe("Au commencement")
    expect(lines[1]).toBe("La terre était informe")
  })

  it("skips untranslated cells", async () => {
    const blob = exportPlainTextDump(CELLS)
    const text = await blobText(blob)
    expect(text).not.toContain("God said")
  })

  it("produces text/plain content type", () => {
    expect(exportPlainTextDump(CELLS).type).toContain("text/plain")
  })

  it("prepends title + blank line when title is provided", async () => {
    const blob = exportPlainTextDump(CELLS, { title: "Genesis" })
    const text = await blobText(blob)
    const lines = text.split("\n")
    expect(lines[0]).toBe("Genesis")
    expect(lines[1]).toBe("") // blank separator
    expect(lines[2]).toBe("Au commencement")
  })

  it("omits title section when title is empty or whitespace-only", async () => {
    const blob = exportPlainTextDump(CELLS, { title: "  " })
    const text = await blobText(blob)
    const lines = text.split("\n")
    expect(lines[0]).toBe("Au commencement")
  })

  it("includes canonical refs as tab-separated prefix when includeRefs=true", async () => {
    const blob = exportPlainTextDump(CELLS, { includeRefs: true })
    const text = await blobText(blob)
    const lines = text.split("\n")
    expect(lines[0]).toBe("GEN 1:1\tAu commencement")
    expect(lines[1]).toBe("GEN 1:2\tLa terre était informe")
  })

  it("returns empty blob for all-untranslated cells", async () => {
    const blob = exportPlainTextDump([makeCell({ translated: "" })])
    const text = await blobText(blob)
    expect(text.trim()).toBe("")
  })

  it("trims whitespace from translated segments", async () => {
    const blob = exportPlainTextDump([makeCell({ translated: "  Hello  " })])
    const text = await blobText(blob)
    expect(text).toBe("Hello")
  })
})
