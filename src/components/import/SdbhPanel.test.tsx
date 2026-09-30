/**
 * SdbhPanel — not-imported gate (AQU-793 follow-up)
 *
 * WHY: when the lexicon has reference lists too large for cell metadata, the
 * panel must stop BEFORE upload, tell the user exactly which fields will be
 * marked "Not imported" and that export stays lossless, and let them cancel
 * (quietly, no error) or proceed. Silent truncation was the bug this replaces.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("@/lib/import-sdbh", async () => {
  const actual = await vi.importActual<typeof import("@/lib/import-sdbh")>("@/lib/import-sdbh")
  return { ...actual, importSdbh: vi.fn() }
})

import { SdbhPanel } from "./SdbhPanel"
import { importSdbh, SdbhImportCancelledError, type SdbhImportHooks } from "@/lib/import-sdbh"

const FIELDS = [{ conId: "000001001001001", lemma: "אָב", field: "references" as const, count: 4321 }]

function mockImportWithGate() {
  vi.mocked(importSdbh).mockImplementation(async (_m, _l, _ctx, _p, _a, hooks?: SdbhImportHooks) => {
    const proceed = await hooks!.confirmNotImported!(FIELDS)
    if (!proceed) throw new SdbhImportCancelledError()
    return {
      refs: [], skipped: [], entryCount: 1, senseCount: 1, contextualMeaningCount: 1,
      sourceCellCount: 1, targetCellCount: 0, targetLanguageCode: null, notImported: FIELDS,
    }
  })
}

async function chooseMasterAndImport() {
  const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]')
  const file = new File(["[]"], "SDBH-en.JSON", { type: "application/json" })
  fireEvent.change(inputs[0], { target: { files: [file] } })
  fireEvent.click(await screen.findByRole("button", { name: "Import" }))
}

describe("SdbhPanel not-imported gate", () => {
  beforeEach(() => {
    vi.mocked(importSdbh).mockReset()
  })

  it("shows the affected lemma, the export note, and cancels quietly", async () => {
    mockImportWithGate()
    const onImported = vi.fn()
    render(<SdbhPanel projectId="p1" username="alice" getToken={async () => "tok"} onImported={onImported} />)
    await chooseMasterAndImport()

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Some reference lists will not be imported")
    expect(dialog).toHaveTextContent("אָב — 4,321 references")
    expect(dialog).toHaveTextContent("original reference data is unchanged")

    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(onImported).not.toHaveBeenCalled()
    expect(screen.queryByText(/cancelled/i)).toBeNull()
    expect(document.querySelector(".text-destructive")).toBeNull()
  })

  it("proceeds when the user confirms", async () => {
    mockImportWithGate()
    const onImported = vi.fn()
    render(<SdbhPanel projectId="p1" username="alice" getToken={async () => "tok"} onImported={onImported} />)
    await chooseMasterAndImport()
    fireEvent.click(await screen.findByRole("button", { name: "Import anyway" }))
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1))
  })
})
