/**
 * AQU-1631 on the AQU-1365 path: a translation import says which language it
 * fills.
 *
 * WHY: the import used to write into whatever lane the editor happened to have
 * open, named nowhere. On a project with several target languages a translator
 * could pour a finished translation into the wrong language and not find out
 * until they switched lanes. AQU-1631 put a "Fill which language" picker on the
 * old three-dot dialog; AQU-1365 replaced that dialog with the Import button's
 * "A translation" screen, so the picker lives there now.
 *
 * Two of these are correctness, not UI. The picker must report the chosen lane
 * to the host, which points it at the editor's own lane setter: the review
 * reads each line's current translation and AD-2 commit parent from the OPEN
 * lane's cells, so the lane filled and the lane read must be the same one. And
 * the lane chosen must be the lane committed into (`targetLang` on
 * `applyEBibleTargetImport`), or the picker is decoration.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("@/lib/import", () => ({
  importFile: vi.fn(),
  importEBible: vi.fn(),
  importMacula: vi.fn(),
  importTranslationNotes: vi.fn(),
  importParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  prepareEBibleTargetImport: vi.fn(),
  applyEBibleTargetImport: vi.fn(),
  prepareImportFile: vi.fn(),
}))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

import { ImportDialog, type TranslationImportHost } from "./ImportDialog"
import { laneComboboxOptions } from "@/components/lane-options"
import { applyEBibleTargetImport } from "@/lib/import"
import type { FileTargetCellRef } from "@/lib/import-file-target"

const JONAH_CELLS: FileTargetCellRef[] = [1, 2].map((verse) => ({
  cellId: `jonah-${verse}`,
  fileId: "jonah",
  canonicalRef: `JON 1:${verse}`,
  sourceEventId: `se-jonah-${verse}`,
  targetEventId: undefined,
  translated: "",
  original: `JON source ${verse}`,
}))

const FILES = [
  { id: "jonah", name: "Jonah", bookCode: "JON", type: "usfm" },
  { id: "ruth", name: "Ruth", bookCode: "RUT", type: "usfm" },
]

const JON_USFM = "\\id JON\n\\c 1\n\\v 1 Йона бер\n\\v 2 Йона ике\n"

/** The project's lanes as the editor's switcher names them: the default lane
 *  by the project's target language, a named lane by its name, an unnamed one
 *  by its tag. */
const LANE_OPTIONS = laneComboboxOptions({
  lanes: ["", "fr", "pt-BR"],
  laneLabels: { fr: "French" },
  defaultLaneLabel: "Spanish",
})
const LANE_NAMES: Record<string, string> = { "": "Spanish", fr: "French", "pt-BR": "pt-BR" }

function host(overrides: Partial<TranslationImportHost> = {}): TranslationImportHost {
  return {
    files: FILES,
    activeFileId: "jonah",
    activeFileCells: JONAH_CELLS,
    activeFileLoading: false,
    activeFileFailed: false,
    openFile: vi.fn(),
    retryActiveFile: vi.fn(),
    applyOptimisticTargetEdits: vi.fn(),
    disabledReason: null,
    languageLabel: "Spanish",
    targetLanguages: [{ language: "Spanish", label: null, active: true }],
    laneOptions: LANE_OPTIONS,
    onLaneChange: vi.fn(),
    ...overrides,
  }
}

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-1631",
  username: "translator",
  sourceLanguage: "English",
  targetLanguage: "Spanish",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

function renderDialog(targetLang: string, overrides: Partial<TranslationImportHost> = {}) {
  const translation = host({ languageLabel: LANE_NAMES[targetLang], ...overrides })
  render(<ImportDialog {...baseProps} targetLang={targetLang} translation={translation} />)
  return translation
}

/** Stands in for ProjectWorkspace: it owns the editor's lane, and the picker's
 *  report re-renders the dialog on it the way `setActiveLane` does. */
function Host({ initialLane }: { initialLane: string }) {
  const [lane, setLane] = React.useState(initialLane)
  return (
    <ImportDialog
      {...baseProps}
      targetLang={lane}
      translation={host({ languageLabel: LANE_NAMES[lane], onLaneChange: setLane })}
    />
  )
}

async function chooseTranslation() {
  fireEvent.click(screen.getByRole("radio", { name: /^A translation/ }))
  return screen.findByTestId("translation-chooser")
}

async function pickLane(name: string) {
  const user = userEvent.setup()
  await user.click(screen.getByTestId("file-target-lane-trigger"))
  await user.click(await screen.findByRole("option", { name }))
}

async function dropUsfm() {
  const input = screen.getByTestId("translation-drop-zone").querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(input, "files", {
      value: [new File([JON_USFM], "JON-tatar.usfm", { type: "text/plain" })],
      configurable: true,
    })
    fireEvent.change(input)
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function importAll() {
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: /import 2 cells/i }))
  })
  await waitFor(() => expect(applyEBibleTargetImport).toHaveBeenCalledTimes(1))
  return vi.mocked(applyEBibleTargetImport).mock.calls[0][2] as { targetLang?: string }
}

describe("A translation: choosing which language it fills (AQU-1631)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("defaults the picker to the lane open in the editor", async () => {
    renderDialog("fr")
    const chooser = await chooseTranslation()
    expect(within(chooser).getByTestId("file-target-lane-trigger")).toHaveTextContent("French")
    expect(chooser).toHaveTextContent("It fills the empty lines of the French translation.")
  })

  it("names the default lane with the project's target language, not an empty tag", async () => {
    renderDialog("")
    await chooseTranslation()
    expect(screen.getByTestId("file-target-lane-trigger")).toHaveTextContent("Spanish")
  })

  it("reports a chosen language to the host so the editor opens it", async () => {
    const translation = renderDialog("")
    await chooseTranslation()
    await pickLane("pt-BR")
    expect(translation.onLaneChange).toHaveBeenCalledWith("pt-BR")
  })

  it("does not churn the editor's lane when the open one is re-picked", async () => {
    const translation = renderDialog("fr")
    await chooseTranslation()
    await pickLane("French")
    expect(translation.onLaneChange).not.toHaveBeenCalled()
  })

  it("hides the picker when the project offers only one language to fill", async () => {
    renderDialog("", { laneOptions: laneComboboxOptions({ lanes: [""], defaultLaneLabel: "Spanish" }) })
    const chooser = await chooseTranslation()
    expect(screen.queryByTestId("file-target-lane-picker")).not.toBeInTheDocument()
    // The sentence naming the language stays, and the import is still reachable.
    expect(chooser).toHaveTextContent("It fills the empty lines of the Spanish translation.")
    await dropUsfm()
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
  })

  it("leaves the screen unchanged for a host that passes no lanes at all", async () => {
    renderDialog("", { laneOptions: undefined, onLaneChange: undefined })
    await chooseTranslation()
    expect(screen.queryByTestId("file-target-lane-picker")).not.toBeInTheDocument()
  })
})

describe("A translation: the chosen language is the one written (AQU-1631)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(applyEBibleTargetImport).mockResolvedValue({ committedCount: 2, skippedCount: 0 })
  })

  it("commits into the language the person picked, not the one the dialog opened on", async () => {
    render(<Host initialLane="" />)
    const chooser = await chooseTranslation()
    await pickLane("pt-BR")
    // The host has re-rendered on the new lane; the screen reflects it.
    expect(screen.getByTestId("file-target-lane-trigger")).toHaveTextContent("pt-BR")
    expect(chooser).toHaveTextContent("It fills the empty lines of the pt-BR translation.")

    await dropUsfm()
    await screen.findByText(/review matches/i)
    expect((await importAll()).targetLang).toBe("pt-BR")
  })

  it("commits into the open language when the picker is left alone", async () => {
    render(<Host initialLane="fr" />)
    await chooseTranslation()
    await dropUsfm()
    await screen.findByText(/review matches/i)
    expect((await importAll()).targetLang).toBe("fr")
  })

  it("keeps the chosen language through Back from the review", async () => {
    render(<Host initialLane="" />)
    await chooseTranslation()
    await pickLane("French")
    await dropUsfm()
    await screen.findByText(/review matches/i)
    fireEvent.click(screen.getByRole("button", { name: "Back to file selection" }))
    await screen.findByTestId("translation-chooser")
    expect(screen.getByTestId("file-target-lane-trigger")).toHaveTextContent("French")
    fireEvent.click(within(screen.getByTestId("translation-held-file")).getByRole("button", { name: "Continue" }))
    await screen.findByText(/review matches/i)
    expect((await importAll()).targetLang).toBe("fr")
  })
})
