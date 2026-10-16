/**
 * FileTargetImportPanel — a failed import must FAIL, visibly (AQU-1669).
 *
 * WHY: a partner's CSV import into a second lane died at the CORS preflight,
 * and the retry then "completed" with no warning while persisting nothing. The
 * translations sat in the editor looking saved and were gone on reopen. Two
 * things had to be true for that to happen, and both are pinned here:
 *
 *   1. the apply reported success without committing anything (fixed in
 *      `applyEBibleTargetImport` — see import.target-ebible.test.ts), and
 *   2. the panel's optimistic patch outlived the failure.
 *
 * So: whatever step fails — the sidecar upload, the enqueue, the unchainable
 * guard — the panel must surface the message, stay open, keep `onImported`
 * unfired, and put every cell back to the text it held before the import.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/lib/import", () => ({ applyEBibleTargetImport: vi.fn() }))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

import { FileTargetImportPanel } from "./FileTargetImportPanel"
import { applyEBibleTargetImport } from "@/lib/import"

// One cell that already holds a translation, so a rollback has something real
// to restore — a rollback to "" would pass even if the restore used the wrong
// field.
const CELLS = [
  {
    cellId: "cell-gen-1-1",
    fileId: "file-1",
    canonicalRef: "GEN 1:1",
    sourceEventId: "se-1",
    translated: "Im Anfang",
    original: "In the beginning",
  },
]

const USFM_FIXTURE = `\\id GEN
\\c 1
\\v 1 Başlangıçta
`

function renderPanel() {
  const onImported = vi.fn()
  const onError = vi.fn()
  const applyOptimisticTargetEdits = vi.fn()
  render(
    <FileTargetImportPanel
      projectId="proj-1"
      username="tester"
      fileName="Genesis.usfm"
      cells={CELLS}
      getToken={async () => "tok"}
      onImported={onImported}
      onError={onError}
      onCancel={() => {}}
      applyOptimisticTargetEdits={applyOptimisticTargetEdits}
      targetLang="tr"
    />,
  )
  return { onImported, onError, applyOptimisticTargetEdits }
}

async function selectFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    fireEvent.change(input)
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** The one row holds a translation already, so it arrives unticked (replacing
 *  existing work is always an explicit choice). Tick it, then import. */
async function selectRowAndImport() {
  const row = document.querySelector('[data-review-cell="cell-gen-1-1"] input[type="checkbox"]') as HTMLInputElement
  await act(async () => {
    fireEvent.click(row)
    await new Promise((r) => setTimeout(r, 0))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /import 1/i }))
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Walk to the review step and press Import, with the apply rejecting. */
async function runFailingImport(error: Error) {
  vi.mocked(applyEBibleTargetImport).mockRejectedValue(error)
  const handles = renderPanel()
  await selectFile(new File([USFM_FIXTURE], "genesis.usfm", { type: "text/plain" }))
  await screen.findByText(/review matches/i)
  await selectRowAndImport()
  return handles
}

describe("FileTargetImportPanel — a failed import cannot report success (AQU-1669)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows the upload failure instead of closing over it", async () => {
    // The partner's exact first-attempt failure: the source PUT never left the
    // browser because the preflight rejected X-Artifact-Target-Lang.
    const { onImported, onError } = await runFailingImport(
      new Error("Source upload failed: NetworkError when attempting to fetch resource."),
    )

    expect(screen.getByText(/source upload failed/i)).toBeInTheDocument()
    // onImported is what closes the dialog and tells the workspace to
    // revalidate — firing it here is precisely the "completed with no warning".
    expect(onImported).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/source upload failed/i), "apply")
  })

  it("restores each cell's prior translation rather than leaving a phantom", async () => {
    const { applyOptimisticTargetEdits } = await runFailingImport(new Error("Source upload failed"))

    // First call paints the incoming text; the last must put the old text back,
    // or the editor keeps showing a translation that was never queued.
    const calls = applyOptimisticTargetEdits.mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0][0]).toEqual([{ cellId: "cell-gen-1-1", value: "Başlangıçta" }])
    expect(calls[calls.length - 1][0]).toEqual([{ cellId: "cell-gen-1-1", value: "Im Anfang" }])
  })

  it("leaves the import re-runnable after the failure", async () => {
    await runFailingImport(new Error("Source upload failed"))
    // Still on the review step with a live button: the user can retry once the
    // cause is gone. A stuck "applying" state would read as a silent hang.
    expect(screen.getByRole("button", { name: /import 1/i })).not.toBeDisabled()
  })

  it("surfaces the unchainable-cells guard the same way", async () => {
    // The guard added in applyEBibleTargetImport for the case that produced the
    // silent loss: selected cells with no AD-2 parent to commit onto.
    const { onImported } = await runFailingImport(
      new Error("Import failed: 1 of the 1 selected lines has no event to chain the translation onto, so nothing was saved."),
    )
    expect(screen.getByText(/no event to chain/i)).toBeInTheDocument()
    expect(onImported).not.toHaveBeenCalled()
  })
})
