/**
 * FRO-430 (fix) — a failed commit must be VISIBLE, never silent.
 *
 * WHY: doCommit() catches commit errors into UploadPanel's local state, but
 * UploadPanel is unmounted during the preview screen, so the error was lost and
 * the dialog returned to the buttons with no explanation — the same silent-
 * failure class FRO-427/FRO-430 set out to kill. The fix threads the error up to
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

describe("PreviewPanel — commit error visibility (FRO-430 fix)", () => {
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
