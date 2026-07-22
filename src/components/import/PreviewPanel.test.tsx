/**
 * AQU-430 (fix) — a failed commit must be VISIBLE, never silent.
 *
 * WHY: doCommit() catches commit errors into UploadPanel's local state, but
 * UploadPanel is unmounted during the preview screen, so the error was lost and
 * the dialog returned to the buttons with no explanation — the same silent-
 * failure class AQU-427/AQU-430 set out to kill. The fix threads the error up to
 * ImportDialog and passes it to PreviewPanel, which shows it above the actions
 * while keeping Confirm/Cancel available for retry.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { PreviewPanel } from "@/components/import/PreviewPanel"
import type { ImportResult } from "@/lib/import"

const MB = 1024 * 1024

const RESULTS: ImportResult[] = [
  { name: "test.docx", strings: [{ id: "s1", original: "Hello world", context: "Paragraph", group: "1" }] },
] as unknown as ImportResult[]

describe("PreviewPanel — commit error visibility (AQU-430 fix)", () => {
  it("shows the error and keeps Confirm/Cancel available when commit fails", () => {
    render(
      <PreviewPanel
        results={RESULTS}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        error="permission denied (403)"
      />,
    )

    const alert = screen.getByTestId("preview-commit-error")
    expect(alert).toHaveTextContent(/permission denied \(403\)/i)
    // The user can still retry or back out — not a dead-end.
    expect(screen.getByRole("button", { name: /confirm import/i })).toBeEnabled()
    expect(screen.getByRole("button", { name: /cancel/i })).toBeEnabled()
  })

  it("renders no error banner when error is null", () => {
    render(<PreviewPanel results={RESULTS} onConfirm={vi.fn()} onCancel={vi.fn()} error={null} />)
    expect(screen.queryByTestId("preview-commit-error")).toBeNull()
  })
})

describe("PreviewPanel — USFM markers stripped from preview (AQU-580)", () => {
  const USFM_RESULT: ImportResult[] = [
    {
      name: "GEN.usfm",
      rawSourceFormat: "usfm",
      strings: [
        {
          id: "v1",
          original:
            "In the \\nd Lord\\nd* beginning God \\add really\\add* created the heavens.\\f + \\fr 1:1 \\ft A note.\\f*",
          context: "GEN 1:1",
          group: "GEN 1:1",
        },
      ],
    },
  ] as unknown as ImportResult[]

  it("shows verse text with no backslash codes for a USFM import", () => {
    render(<PreviewPanel results={USFM_RESULT} onConfirm={vi.fn()} onCancel={vi.fn()} error={null} />)
    // Translator-facing preview must be clean: markers, footnotes, and word-
    // level tags removed — never a raw backslash.
    expect(screen.getByText(/In the Lord beginning God really created the heavens\./)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain("\\")
  })

  it("leaves non-USFM text verbatim (backslashes are not USFM there)", () => {
    const TSV: ImportResult[] = [
      { name: "notes.tsv", rawSourceFormat: "tsv", strings: [{ id: "a", original: "path C:\\Users\\x", context: "1", group: "1" }] },
    ] as unknown as ImportResult[]
    render(<PreviewPanel results={TSV} onConfirm={vi.fn()} onCancel={vi.fn()} error={null} />)
    expect(screen.getByText(/C:\\Users\\x/)).toBeInTheDocument()
  })
})

describe("PreviewPanel — transferred-size readout during upload (AQU-520)", () => {
  it("shows an X / Y MB readout alongside the cell count while committing", async () => {
    // onConfirm never resolves, so the panel stays in its in-progress view and
    // renders the uploadProgress the parent supplies.
    render(
      <PreviewPanel
        results={RESULTS}
        onConfirm={() => new Promise<void>(() => {})}
        onCancel={vi.fn()}
        uploadPhase="Uploading test.usfm"
        uploadProgress={{ count: 100, total: 400, bytesReceived: 10 * MB, bytesTotal: 40 * MB }}
        error={null}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /confirm import/i }))

    const bytes = await screen.findByTestId("preview-upload-bytes")
    expect(bytes).toHaveTextContent("10.0 / 40.0 MB (25%)")
  })

  it("omits the MB readout when byte totals are unavailable (e.g. media with no size)", () => {
    render(
      <PreviewPanel
        results={RESULTS}
        onConfirm={() => new Promise<void>(() => {})}
        onCancel={vi.fn()}
        uploadProgress={{ count: 100, total: 400 }}
        error={null}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /confirm import/i }))
    expect(screen.queryByTestId("preview-upload-bytes")).toBeNull()
  })
})

describe("PreviewPanel — AI-assisted imports (AQU-635)", () => {
  it("shows the proposed classification, confidence, and fidelity warning before confirmation", () => {
    render(
      <PreviewPanel
        results={[{
          name: "legacy.odd",
          strings: [{
            id: "one",
            original: "Opening",
            translated: "Ouverture",
            context: "Record 1",
            group: "record-1",
            type: "heading",
          }],
          importClassification: {
            category: "document",
            confidence: 0.87,
            explanation: "The file is organized as pipe-delimited records.",
            recipe: {
              version: 1,
              id: "ai-recipe-1",
              name: "Pipe records",
              inputFormat: "legacy-text",
              strategy: "records",
              config: { recordMode: "delimited", delimiter: "|" },
              proposedBy: "ai",
            },
          },
        }]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId("ai-import-classification")).toHaveTextContent("document")
    expect(screen.getByTestId("ai-import-classification")).toHaveTextContent("87% confidence")
    expect(screen.getByTestId("ai-import-classification")).toHaveTextContent("translated round-trip is not yet verified")
    expect(screen.getByLabelText("Structural content")).toHaveTextContent("—")
  })

  it("marks a low-confidence classification for careful review", () => {
    render(
      <PreviewPanel
        results={[{
          name: "uncertain.data",
          strings: [{ id: "one", original: "Text", translated: "", context: "1", group: "1", type: "text" }],
          importClassification: {
            category: "other",
            confidence: 0.52,
            explanation: "The record boundaries are ambiguous.",
            recipe: {
              version: 1,
              id: "ai-recipe-low",
              name: "Tentative lines",
              inputFormat: "unknown",
              strategy: "records",
              config: { recordMode: "line" },
              proposedBy: "ai",
            },
          },
        }]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText("Needs careful review")).toBeInTheDocument()
  })

  it("shows a parser downgrade notice before the user can confirm", () => {
    render(
      <PreviewPanel
        results={[{
          ...RESULTS[0],
          importNotices: [{
            code: "basic-parser-fallback",
            severity: "warning",
            message: "AI review was unavailable, so the basic parser was used.",
          }],
        }]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByTestId("import-preview-notices")).toHaveTextContent("Review before importing")
    expect(screen.getByTestId("import-preview-notices")).toHaveTextContent("AI review was unavailable")
  })
})
