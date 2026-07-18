/**
 * Slice B — Door43 (DCS) source option wiring in ImportDialog.
 *
 * WHY each test matters:
 *  1. The Door43 option only appears when the host can persist the release
 *     cursor (patchDcsCursor supplied). Without it the import can't pin a
 *     release, so offering it would strand the user — the option must hide.
 *  2. When patchDcsCursor IS supplied, selecting the option navigates to the
 *     catalog browser (the import entry point). This is the whole feature's
 *     front door; if the card doesn't route, nothing downstream can happen.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"

// The DCS catalog browser hits the network on mount; stub it so this test
// exercises ImportDialog's routing/gating, not the real client.
vi.mock("@/components/dcs/DcsCatalogBrowser", () => ({
  DcsCatalogBrowser: () => <div data-testid="dcs-catalog-browser">catalog browser</div>,
}))
vi.mock("@/lib/dcs/import-dcs", () => ({ importDcsResource: vi.fn() }))
vi.mock("@/lib/dcs/catalog", () => ({ DcsClient: class {} }))

// Heavy deps ImportDialog pulls in (mirrors the collision test's stubs).
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
}))
vi.mock("@/lib/import-sdbh", () => ({ importSdbh: vi.fn() }))
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

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-dcs",
  username: "lead",
  sourceLanguage: "en",
  targetLanguage: "fr",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

describe("ImportDialog — Door43 (DCS) source", () => {
  beforeEach(() => vi.clearAllMocks())

  it("hides the Door43 option when patchDcsCursor is not supplied", async () => {
    await act(async () => {
      render(<ImportDialog {...baseProps} />)
    })
    // Landing renders; the Door43 card is absent (can't pin without a patcher).
    expect(screen.queryByText("Door43 (DCS)")).toBeNull()
  })

  it("shows the Door43 option and routes to the catalog browser on select", async () => {
    await act(async () => {
      render(<ImportDialog {...baseProps} patchDcsCursor={vi.fn(async () => true)} />)
    })

    const card = await screen.findByText("Door43 (DCS)")
    await act(async () => {
      fireEvent.click(card)
    })

    await waitFor(() => {
      expect(screen.getByTestId("dcs-catalog-browser")).toBeTruthy()
    })
  })
})
