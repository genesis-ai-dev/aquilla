/**
 * AQU-2487 (import sweep, Nov 2): the SDBH lexicon import inside the Import
 * dialog asks before it leaves reference lists out.
 *
 * WHY: AQU-1369 added the "Some reference lists will not be imported" question
 * to a copy of the SDBH panel the dialog never showed. The dialog's own panel
 * passed no question to the importer, so every reference list over the limit
 * was marked "not imported" with nothing said. This drives the dialog itself,
 * so the question can't land beside the live panel again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"

vi.mock("@/components/dcs/DcsCatalogBrowser", () => ({ DcsCatalogBrowser: () => null }))
vi.mock("@/lib/dcs/import-dcs", () => ({ importDcsResource: vi.fn() }))
vi.mock("@/lib/dcs/catalog", () => ({ DcsClient: class {} }))
vi.mock("@/lib/import", () => ({
  importFile: vi.fn(),
  importEBible: vi.fn(),
  importObs: vi.fn(),
  importHelloao: vi.fn(),
  importMacula: vi.fn(),
  importTranslationNotes: vi.fn(),
  prepareParatextProject: vi.fn(),
  commitParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  prepareEBibleTargetImport: vi.fn(),
  applyEBibleTargetImport: vi.fn(),
  parseFile: vi.fn(async () => []),
  prepareImportFile: vi.fn(async () => ({ fileType: "txt", results: [] })),
}))
vi.mock("@/lib/import-sdbh", async () => {
  const actual = await vi.importActual<typeof import("@/lib/import-sdbh")>("@/lib/import-sdbh")
  return { ...actual, importSdbh: vi.fn() }
})
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
vi.mock("@/lib/parsers/paratext-project", () => ({ detectParatextProject: vi.fn(() => null) }))
vi.mock("@/lib/parsers/ebible", () => ({
  fetchTranslationsList: vi.fn(async () => []),
  fetchTranslationText: vi.fn(async () => ""),
  parseEBibleCorpus: vi.fn(() => []),
}))
vi.mock("@/lib/parsers/helloao", () => ({
  fetchHelloaoTranslations: vi.fn(async () => []),
  fetchHelloaoBooks: vi.fn(async () => []),
}))
vi.mock("uuid", () => ({ v7: () => "mock-uuid" }))

import { ImportDialog } from "./ImportDialog"
import { importSdbh, SdbhImportCancelledError, type SdbhImportHooks } from "@/lib/import-sdbh"

const FIELDS = [{ conId: "000001001001001", lemma: "אָב", field: "references" as const, count: 4321 }]

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-sdbh",
  username: "lead",
  sourceLanguage: "en",
  targetLanguage: "fr",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

async function openSdbhAndImport() {
  await act(async () => {
    render(<ImportDialog {...baseProps} />)
  })
  await act(async () => {
    fireEvent.click(await screen.findByText("SDBH Hebrew Lexicon"))
  })
  const master = await waitFor(() => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept=".json,.JSON"]')
    if (!input) throw new Error("the SDBH panel is not showing")
    return input
  })
  fireEvent.change(master, { target: { files: [new File(["[]"], "SDBH-en.JSON", { type: "application/json" })] } })
  fireEvent.click(await screen.findByRole("button", { name: "Import" }))
}

describe("ImportDialog — SDBH lexicon", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(importSdbh).mockImplementation(async (_m, _l, _ctx, _p, _a, hooks?: SdbhImportHooks) => {
      // The importer only asks when the panel hands it a way to ask.
      const proceed = hooks?.confirmNotImported ? await hooks.confirmNotImported(FIELDS) : true
      if (!proceed) throw new SdbhImportCancelledError()
      return {
        refs: [], skipped: [], entryCount: 1, senseCount: 1, contextualMeaningCount: 1,
        sourceCellCount: 1, targetCellCount: 0, targetLanguageCode: null, notImported: FIELDS,
      }
    })
  })

  it("asks before importing a lexicon whose reference lists will be left out, and Cancel stops it", async () => {
    await openSdbhAndImport()

    const question = await screen.findByRole("alertdialog")
    expect(question).toHaveTextContent("Some reference lists will not be imported")
    expect(question).toHaveTextContent("אָב")
    expect(baseProps.onImported).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(baseProps.onImported).not.toHaveBeenCalled()
    expect(document.querySelector(".text-destructive")).toBeNull()
  })
})
