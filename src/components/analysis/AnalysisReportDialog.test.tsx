// AQU-1392: the dialog's contract — it runs the analysis itself, renders the
// band table and weighted total, exports CSV, and abandons the run when it
// closes.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AnalysisReportDialog } from "./AnalysisReportDialog"
import type { AnalyzableFile } from "@/lib/analysis/run-analysis"

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
})

const files: AnalyzableFile[] = [{ fileId: "f1", name: "Genesis" }]

const sources: Record<string, string[]> = {
  f1: ["in the beginning", "in the beginning"],
  f2: ["these are the names"],
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof AnalysisReportDialog>> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    scope: "file" as const,
    label: "Genesis",
    files,
    loadSources: async (f: AnalyzableFile) => sources[f.fileId] ?? [],
    ...overrides,
  }
  return { ...render(<AnalysisReportDialog {...props} />), props }
}

describe("AnalysisReportDialog", () => {
  it("shows the band table and the weighted total once the run finishes", async () => {
    renderDialog()

    await waitFor(() => expect(screen.getByTestId("analysis-band-new")).toBeVisible())

    // 3 new words + 3 repeated words = 6 raw, 3.9 weighted.
    expect(screen.getByTestId("analysis-total-words")).toHaveTextContent("6")
    expect(screen.getByTestId("analysis-weighted-words")).toHaveTextContent("3.9")
    expect(screen.getByTestId("analysis-saving")).toHaveTextContent("35%")
    expect(screen.getByTestId("analysis-band-repetition")).toHaveTextContent("Repetitions")
  })

  it("lists the bands nothing fills yet, with the note that explains the zeros", async () => {
    renderDialog()

    await waitFor(() => expect(screen.getByTestId("analysis-band-ice")).toBeVisible())
    expect(screen.getByText(/rate card stays complete/i)).toBeVisible()
    expect(screen.getByText(/not editable yet/i)).toBeVisible()
  })

  it("aggregates every file for a project-scoped report", async () => {
    renderDialog({
      scope: "project",
      label: "Pentateuch",
      files: [
        { fileId: "f1", name: "Genesis" },
        { fileId: "f2", name: "Exodus" },
      ],
    })

    await waitFor(() => expect(screen.getByTestId("analysis-total-segments")).toHaveTextContent("3"))
    expect(screen.getByTestId("analysis-total-words")).toHaveTextContent("10")
  })

  it("exports the report as CSV", async () => {
    const onDownload = vi.fn()
    renderDialog({ onDownload })

    await waitFor(() => expect(screen.getByTestId("analysis-band-new")).toBeVisible())
    await userEvent.click(screen.getByRole("button", { name: /export csv/i }))

    expect(onDownload).toHaveBeenCalledTimes(1)
    const [csv, filename] = onDownload.mock.calls[0]
    expect(filename).toBe("Genesis-analysis.csv")
    expect(csv).toContain("Weighted (payable) words,3.9")
  })

  it("keeps the export disabled until there is a report to export", () => {
    renderDialog({ loadSources: () => new Promise(() => {}) })

    expect(screen.getByRole("button", { name: /export csv/i })).toBeDisabled()
    expect(screen.getByRole("status")).toBeVisible()
  })

  it("names the files whose source could not be read", async () => {
    renderDialog({
      scope: "project",
      label: "P",
      files: [
        { fileId: "f1", name: "Genesis" },
        { fileId: "f2", name: "Exodus" },
      ],
      loadSources: async (f: AnalyzableFile) => {
        if (f.fileId === "f2") throw new Error("403")
        return sources[f.fileId]
      },
    })

    await waitFor(() => expect(screen.getByTestId("analysis-skipped")).toHaveTextContent("Exodus"))
    // Genesis still counts — one unreadable file does not sink the report.
    expect(screen.getByTestId("analysis-total-words")).toHaveTextContent("6")
  })

  it("abandons the run when it closes rather than loading the rest", async () => {
    const loadSources = vi.fn(async (f: AnalyzableFile) => sources[f.fileId] ?? [])
    const { rerender, props } = renderDialog({
      scope: "project",
      label: "P",
      files: [
        { fileId: "f1", name: "Genesis" },
        { fileId: "f2", name: "Exodus" },
      ],
      loadSources,
    })

    await waitFor(() => expect(loadSources).toHaveBeenCalled())
    rerender(<AnalysisReportDialog {...props} open={false} />)
    const callsAtClose = loadSources.mock.calls.length

    await new Promise((r) => setTimeout(r, 20))
    expect(loadSources.mock.calls.length).toBe(callsAtClose)
  })
})
