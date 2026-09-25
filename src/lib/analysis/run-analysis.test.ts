// AQU-1392: the runner's job is to stay responsive and to survive one bad
// file. Both are tested here with an in-memory loader — no network, no React.
import { describe, it, expect, vi } from "vitest"
import { runAnalysis, type AnalyzableFile } from "./run-analysis"

const files: AnalyzableFile[] = [
  { fileId: "a", name: "Genesis" },
  { fileId: "b", name: "Exodus" },
  { fileId: "c", name: "Leviticus" },
]

const sourcesByFile: Record<string, string[]> = {
  a: ["in the beginning", "in the beginning"],
  b: ["these are the names"],
  c: ["the LORD called"],
}

const loadSources = async (f: AnalyzableFile) => sourcesByFile[f.fileId] ?? []

describe("runAnalysis", () => {
  it("aggregates every file into one project report", async () => {
    const { report, skipped, aborted } = await runAnalysis({
      files,
      loadSources,
      scope: "project",
      label: "Pentateuch",
      yieldToUi: async () => {},
    })

    expect(aborted).toBe(false)
    expect(skipped).toEqual([])
    expect(report.scope).toBe("project")
    expect(report.label).toBe("Pentateuch")
    expect(report.files.map((f) => f.name)).toEqual(["Genesis", "Exodus", "Leviticus"])
    expect(report.totalSegments).toBe(4)
    // 3 + 3 new-then-repeat in Genesis, 4 in Exodus, 3 in Leviticus.
    expect(report.totalWords).toBe(13)
    expect(report.bands.find((b) => b.band === "repetition")?.segments).toBe(1)
  })

  it("hands the event loop back between files, but never inside one", async () => {
    const yieldToUi = vi.fn(async () => {})

    await runAnalysis({ files, loadSources, scope: "project", label: "P", yieldToUi })

    // One yield after each file except the last — a trailing yield would just
    // delay the finished report.
    expect(yieldToUi).toHaveBeenCalledTimes(files.length - 1)
  })

  it("reports progress after each file", async () => {
    const seen: string[] = []

    await runAnalysis({
      files,
      loadSources,
      scope: "project",
      label: "P",
      yieldToUi: async () => {},
      onProgress: (p) => seen.push(`${p.done}/${p.total} ${p.current}`),
    })

    expect(seen).toEqual(["1/3 Genesis", "2/3 Exodus", "3/3 Leviticus"])
  })

  it("skips a file whose source cannot be read and still reports the rest", async () => {
    const { report, skipped } = await runAnalysis({
      files,
      loadSources: async (f) => {
        if (f.fileId === "b") throw new Error("403 forbidden")
        return sourcesByFile[f.fileId]
      },
      scope: "project",
      label: "P",
      yieldToUi: async () => {},
    })

    expect(skipped).toEqual([{ fileId: "b", name: "Exodus", reason: "403 forbidden" }])
    expect(report.files.map((f) => f.name)).toEqual(["Genesis", "Leviticus"])
    expect(report.totalSegments).toBe(3)
  })

  it("stops on an aborted signal and says the report is partial", async () => {
    const controller = new AbortController()
    const loaded: string[] = []

    const { report, aborted } = await runAnalysis({
      files,
      loadSources: async (f) => {
        loaded.push(f.fileId)
        if (f.fileId === "a") controller.abort()
        return sourcesByFile[f.fileId]
      },
      scope: "project",
      label: "P",
      signal: controller.signal,
      yieldToUi: async () => {},
    })

    expect(aborted).toBe(true)
    // The in-flight file is dropped rather than banded: nobody will see it.
    expect(loaded).toEqual(["a"])
    expect(report.files).toEqual([])
  })

  it("returns an empty report for a project with no files", async () => {
    const { report } = await runAnalysis({
      files: [],
      loadSources,
      scope: "project",
      label: "Empty",
      yieldToUi: async () => {},
    })

    expect(report.totalWords).toBe(0)
    expect(report.files).toEqual([])
  })
})
