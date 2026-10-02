/**
 * AQU-1365: a translation starts from the big Import button.
 *
 * WHY each group matters:
 *  - The first screen still opens on New source text with the importer tiles
 *    right below it: a source import must not gain a click (AC3), and the e2e
 *    page objects wait for the "Upload files" card.
 *  - "A translation" must be findable by the words people use (AQU-503:
 *    "target"), and must default to the open file.
 *  - The review matches against the lines it is handed when it mounts, so a
 *    translation for another file must wait until that file is open and fully
 *    loaded. Starting early matches against the wrong file's lines.
 *  - A USFM file's own book may choose the file only while the person hasn't.
 *  - Roles: a Contributor imports a translation (the old three-dot entry had
 *    no gate), but not new source text.
 *  - The importers that only fill a translation (eBible into the target
 *    column, a paired spreadsheet) live under A translation, so New source
 *    text never offers a way to fill a file's target. They read the chosen
 *    file's lines too, so they wait for it to open like a dropped file does.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react"
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
vi.mock("@/lib/parsers/ebible", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/parsers/ebible")>()),
  fetchTranslationsList: vi.fn(async () => [{
    id: "ttrBSB", title: "Tatar Bible", languageCode: "tat", languageName: "Татар", languageNameInEnglish: "Tatar",
    otBooks: 39, ntBooks: 27, copyright: "",
  }]),
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

import { ImportDialog, type TranslationImportHost } from "./ImportDialog"
import { applyEBibleTargetImport, prepareEBibleTargetImport } from "@/lib/import"
import posthog from "@/lib/posthog"
import { IMPORT_STARTED, IMPORT_SUCCEEDED } from "@/lib/event-names"
import type { FileTargetCellRef } from "@/lib/import-file-target"

function cellsFor(fileId: string, book: string, verses: number): FileTargetCellRef[] {
  return Array.from({ length: verses }, (_, i) => ({
    cellId: `${fileId}-${i + 1}`,
    fileId,
    canonicalRef: `${book} 1:${i + 1}`,
    sourceEventId: `se-${fileId}-${i + 1}`,
    targetEventId: undefined,
    translated: "",
    original: `${book} source ${i + 1}`,
  }))
}

const JONAH_CELLS = cellsFor("jonah", "JON", 2)
const RUTH_CELLS = cellsFor("ruth", "RUT", 2)

const FILES = [
  { id: "jonah", name: "Jonah", bookCode: "JON", type: "usfm" },
  { id: "ruth", name: "Ruth", bookCode: "RUT", type: "usfm" },
  { id: "episode", name: "Episode 1", type: "vtt" },
]

const JON_USFM = "\\id JON Siberian Tatar (test)\n\\c 1\n\\v 1 Йона бер\n\\v 2 Йона ике\n"
const RUT_USFM = "\\id RUT\n\\c 1\n\\v 1 Руфь бер\n\\v 2 Руфь ике\n"

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
    languageLabel: "Siberian Tatar",
    targetLanguages: ["Siberian Tatar"],
    ...overrides,
  }
}

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-1365",
  username: "translator",
  sourceLanguage: "English",
  targetLanguage: "Siberian Tatar",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
}

function renderDialog(props: Partial<React.ComponentProps<typeof ImportDialog>> = {}) {
  const translation = props.translation ?? host()
  const all = { ...baseProps, translation, ...props }
  const view = render(<ImportDialog {...all} />)
  return {
    ...view,
    translation,
    rerenderWith: (next: Partial<TranslationImportHost>) =>
      view.rerender(<ImportDialog {...all} translation={{ ...translation, ...next }} />),
  }
}

function usfm(text: string, name: string) {
  return new File([text], name, { type: "text/plain" })
}

async function chooseTranslation() {
  fireEvent.click(screen.getByRole("radio", { name: /^A translation/ }))
  return screen.findByTestId("translation-chooser")
}

async function dropFiles(files: File[]) {
  const input = screen.getByTestId("translation-drop-zone").querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(input, "files", { value: files, configurable: true })
    fireEvent.change(input)
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function pickFile(name: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole("combobox", { name: "Which file does it translate?" }))
  await user.click(await screen.findByRole("option", { name }))
}

describe("AQU-1365: the Import dialog's first screen", () => {
  beforeEach(() => vi.clearAllMocks())

  it("opens on New source text with today's importer tiles below it", () => {
    renderDialog()
    expect(screen.getByRole("radio", { name: /^New source text/ })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("Upload files")).toBeInTheDocument()
    expect(screen.queryByTestId("translation-chooser")).not.toBeInTheDocument()
  })

  it("names the translation choice by the words people look for: translation, target", () => {
    renderDialog()
    const card = screen.getByTestId("import-intent-translation").textContent!.toLowerCase()
    expect(card).toContain("translation")
    expect(card).toContain("target")
  })

  it("offers no choice at all when the host has no translation path", () => {
    renderDialog({ translation: undefined })
    expect(screen.queryByRole("radio", { name: /^A translation/ })).not.toBeInTheDocument()
    expect(screen.getByText("Upload files")).toBeInTheDocument()
  })

  it("preselects the open file and says which language it fills", async () => {
    renderDialog()
    const chooser = await chooseTranslation()
    expect(screen.queryByText("Upload files")).not.toBeInTheDocument()
    expect(within(chooser).getByRole("combobox", { name: "Which file does it translate?" })).toHaveTextContent("Jonah")
    expect(chooser).toHaveTextContent("It fills the empty lines of the Siberian Tatar translation.")
  })

  it("greys out New source text for a Contributor and opens on A translation", () => {
    renderDialog({ sourceDisabledReason: "You're a Contributor; you need at least Project lead access." })
    expect(screen.getByRole("radio", { name: /^New source text/ })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByTestId("import-intent-source")).toHaveAttribute(
      "data-tooltip", "You're a Contributor; you need at least Project lead access.",
    )
    expect(screen.getByRole("radio", { name: /^A translation/ })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("translation-chooser")).toBeInTheDocument()
  })

  it("greys out A translation in a project with no files, and says why", () => {
    renderDialog({ translation: host({ files: [], activeFileId: null, activeFileCells: [] }) })
    expect(screen.getByRole("radio", { name: /^A translation/ })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByTestId("import-intent-translation")).toHaveAttribute(
      "data-tooltip", "Add a source text first. A translation goes into a file that's already here.",
    )
  })
})

describe("AQU-1365: importing a translation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(applyEBibleTargetImport).mockResolvedValue({ committedCount: 2, skippedCount: 0 })
  })

  it("goes straight to the review for the open, loaded file, without reopening it", async () => {
    const { translation } = renderDialog()
    await chooseTranslation()
    await dropFiles([usfm(JON_USFM, "JON-tatar.usfm")])
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(/2 matched/i)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Import a translation into Jonah" })).toBeInTheDocument()
    expect(translation.openFile).not.toHaveBeenCalled()
    expect(screen.queryByText(/opening/i)).not.toBeInTheDocument()
  })

  it("opens another file first and starts the review only once its lines are loaded", async () => {
    const { translation, rerenderWith } = renderDialog()
    await chooseTranslation()
    await pickFile("Ruth")
    await dropFiles([usfm(RUT_USFM, "RUT-tatar.usfm")])
    expect(translation.openFile).toHaveBeenCalledWith("ruth")
    expect(await screen.findByText("Opening Ruth…")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Import a translation into Ruth" })).toBeInTheDocument()

    // The editor switched, but Jonah's rows are still in the store: keep waiting.
    rerenderWith({ activeFileId: "ruth" })
    expect(screen.getByText("Opening Ruth…")).toBeInTheDocument()
    rerenderWith({ activeFileId: "ruth", activeFileCells: [], activeFileLoading: true })
    expect(screen.getByText("Opening Ruth…")).toBeInTheDocument()
    rerenderWith({ activeFileId: "ruth", activeFileCells: RUTH_CELLS, activeFileLoading: false })
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(/2 matched/i)).toBeInTheDocument()
  })

  it("lets a USFM file's book choose the file while the person hasn't", async () => {
    const { translation } = renderDialog()
    await chooseTranslation()
    await dropFiles([usfm(RUT_USFM, "RUT-tatar.usfm")])
    expect(translation.openFile).toHaveBeenCalledWith("ruth")
    expect(screen.getByRole("heading", { name: "Import a translation into Ruth" })).toBeInTheDocument()
  })

  it("keeps the person's own choice over the file's book", async () => {
    const { translation } = renderDialog()
    await chooseTranslation()
    await pickFile("Jonah")
    await dropFiles([usfm(RUT_USFM, "RUT-tatar.usfm")])
    expect(translation.openFile).not.toHaveBeenCalled()
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Import a translation into Jonah" })).toBeInTheDocument()
  })

  it("offers the file the upload is for after the person picked another, and switches with the same upload", async () => {
    const { translation, rerenderWith } = renderDialog()
    await chooseTranslation()
    await pickFile("Jonah")
    await dropFiles([usfm(RUT_USFM, "RUT-tatar.usfm")])
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    const note = screen.getByText(/This file is for Ruth 1/)
    expect(note).toHaveTextContent("This file is for Ruth 1; the open file is Jonah 1.")
    fireEvent.click(within(note).getByRole("button", { name: "Import into Ruth instead" }))
    expect(translation.openFile).toHaveBeenCalledWith("ruth")
    expect(await screen.findByText("Opening Ruth…")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Import a translation into Ruth" })).toBeInTheDocument()
    expect(posthog.capture).toHaveBeenCalledWith(IMPORT_STARTED, expect.objectContaining({
      import_type: "file-target", entry: "review-switch", auto_picked: false,
    }))
    rerenderWith({ activeFileId: "ruth", activeFileCells: RUTH_CELLS })
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(/2 matched/i)).toBeInTheDocument()
    expect(screen.queryByText(/This file is for/)).not.toBeInTheDocument()
  })

  it("holds an upload until a file is chosen, and starts it only on Continue", async () => {
    const { translation } = renderDialog({ translation: host({ activeFileId: null, activeFileCells: [] }) })
    await chooseTranslation()
    await dropFiles([new File(["Reference,Translation\nJON 1:1,a\n"], "JON-tatar.csv")])
    const held = await screen.findByTestId("translation-held-file")
    expect(held).toHaveTextContent("JON-tatar.csv")
    expect(held).toHaveTextContent("Choose the file that JON-tatar.csv translates.")
    expect(within(held).getByRole("button", { name: "Continue" })).toBeDisabled()

    await pickFile("Jonah")
    expect(translation.openFile).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByTestId("translation-held-file")).getByRole("button", { name: "Continue" }))
    expect(translation.openFile).toHaveBeenCalledWith("jonah")
    expect(await screen.findByText("Opening Jonah…")).toBeInTheDocument()
  })

  it("asks for one file at a time", async () => {
    renderDialog()
    await chooseTranslation()
    fireEvent.drop(screen.getByTestId("translation-drop-zone"), {
      dataTransfer: { files: [usfm(JON_USFM, "a.usfm"), usfm(RUT_USFM, "b.usfm")] },
    })
    expect(await screen.findByText("Add one file at a time.")).toBeInTheDocument()
    expect(screen.queryByText(/review matches/i)).not.toBeInTheDocument()
  })

  it("refuses a file type the review can't read", async () => {
    renderDialog()
    await chooseTranslation()
    await dropFiles([new File(["x"], "notes.docx")])
    expect(await screen.findByText(/unsupported file type/i)).toBeInTheDocument()
  })

  it("goes back from the review to the file choice, keeping the file and the upload", async () => {
    renderDialog()
    await chooseTranslation()
    await dropFiles([usfm(JON_USFM, "JON-tatar.usfm")])
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Back to file selection" }))
    const chooser = await screen.findByTestId("translation-chooser")
    expect(within(chooser).getByRole("combobox", { name: "Which file does it translate?" })).toHaveTextContent("Jonah")
    expect(screen.getByTestId("translation-held-file")).toHaveTextContent("JON-tatar.usfm")
    expect(screen.getByRole("radio", { name: /^A translation/ })).toHaveAttribute("aria-checked", "true")
  })

  it("imports, reports it as a file-target import, and closes", async () => {
    const onOpenChange = vi.fn()
    const { translation } = renderDialog({ onOpenChange })
    await chooseTranslation()
    await dropFiles([usfm(JON_USFM, "JON-tatar.usfm")])
    const importButton = await screen.findByRole("button", { name: /import 2 cells/i })
    await act(async () => {
      fireEvent.click(importButton)
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(translation.applyOptimisticTargetEdits).toHaveBeenCalled()
    expect(posthog.capture).toHaveBeenCalledWith(IMPORT_SUCCEEDED, expect.objectContaining({
      import_type: "file-target", entry: "translation", auto_picked: false, file_count: 2,
    }))
  })

  it("says when the file failed to open, and tries again", async () => {
    const { translation, rerenderWith } = renderDialog()
    await chooseTranslation()
    await pickFile("Ruth")
    await dropFiles([usfm(RUT_USFM, "RUT-tatar.usfm")])
    rerenderWith({ activeFileId: "ruth", activeFileCells: [], activeFileFailed: true })
    expect(await screen.findByText("Couldn't open Ruth. Check your connection and try again.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(translation.retryActiveFile).toHaveBeenCalledTimes(1)
  })

  it("hands the upload back when the file is deleted while it opens", async () => {
    const { rerenderWith } = renderDialog()
    await chooseTranslation()
    await pickFile("Ruth")
    await dropFiles([usfm(RUT_USFM, "RUT-tatar.usfm")])
    rerenderWith({ files: FILES.filter((f) => f.id !== "ruth") })
    expect(await screen.findByText("That file is no longer in this project.")).toBeInTheDocument()
    expect(screen.getByTestId("translation-held-file")).toHaveTextContent("RUT-tatar.usfm")
  })

  it("does not wait forever on an open file that has no lines", async () => {
    renderDialog({ translation: host({ activeFileCells: [] }) })
    await chooseTranslation()
    await dropFiles([usfm(JON_USFM, "JON-tatar.usfm")])
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
  })
})

describe("AQU-1365: the translation-only importers live under A translation", () => {
  beforeEach(() => vi.clearAllMocks())

  function otherWay(name: RegExp) {
    return within(screen.getByTestId("translation-other-ways")).getByRole("button", { name })
  }

  it("shows eBible as source only under New source text, with no target tabs", async () => {
    renderDialog({ sourceCells: JONAH_CELLS })
    fireEvent.click(screen.getByRole("button", { name: /^eBible Corpus/ }))
    expect(await screen.findByText("Tatar Bible")).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Into target column" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "New source file" })).not.toBeInTheDocument()
    expect(screen.getByText(/Import a Bible translation directly from the/)).toBeInTheDocument()
  })

  it("keeps eBible's target tabs for a host with no translation path", async () => {
    renderDialog({ translation: undefined, sourceCells: JONAH_CELLS })
    fireEvent.click(screen.getByRole("button", { name: /^eBible Corpus/ }))
    expect(await screen.findByRole("tab", { name: "Into target column" })).toBeInTheDocument()
  })

  it("leaves Paired translation out of the source importers", () => {
    const { unmount } = renderDialog()
    expect(screen.getByText("Translation Memory")).toBeInTheDocument()
    expect(screen.queryByText("Paired translation")).not.toBeInTheDocument()
    unmount()
    renderDialog({ translation: undefined })
    expect(screen.getByText("Paired translation")).toBeInTheDocument()
  })

  it("offers the other ways under A translation, disabled until a file is chosen", async () => {
    renderDialog({ translation: host({ activeFileId: null, activeFileCells: [] }) })
    const chooser = await chooseTranslation()
    expect(within(chooser).getByRole("heading", { name: "Other ways to bring in a translation" })).toBeInTheDocument()
    expect(chooser).toHaveTextContent("Choose the file first.")
    expect(otherWay(/^eBible Corpus/)).toBeDisabled()
    expect(otherWay(/^Paired translation/)).toBeDisabled()
    await pickFile("Ruth")
    expect(otherWay(/^eBible Corpus/)).toBeEnabled()
    expect(otherWay(/^Paired translation/)).toBeEnabled()
    expect(chooser).not.toHaveTextContent("Choose the file first.")
  })

  it("opens the chosen file first, then eBible in target mode against its lines", async () => {
    vi.mocked(prepareEBibleTargetImport).mockResolvedValue({ matched: [], orphans: [], unmatchedSourceCount: 0 })
    const { translation, rerenderWith } = renderDialog()
    await chooseTranslation()
    await pickFile("Ruth")
    fireEvent.click(otherWay(/^eBible Corpus/))
    expect(translation.openFile).toHaveBeenCalledWith("ruth")
    expect(await screen.findByText("Opening Ruth…")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Import a translation into Ruth" })).toBeInTheDocument()
    expect(posthog.capture).toHaveBeenCalledWith(IMPORT_STARTED, expect.objectContaining({
      import_type: "ebible", entry: "translation", auto_picked: false,
    }))

    rerenderWith({ activeFileId: "ruth", activeFileCells: RUTH_CELLS })
    expect(await screen.findByText("Tatar Bible")).toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    expect(screen.getByText(/Match eBible verses to existing source cells/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("Tatar Bible"))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next: Review matches" }))
    })
    expect(prepareEBibleTargetImport).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ttrBSB" }),
      RUTH_CELLS,
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it("opens a paired spreadsheet for the open file straight away, and Cancel goes back to the file choice", async () => {
    const { translation } = renderDialog()
    await chooseTranslation()
    fireEvent.click(otherWay(/^Paired translation/))
    expect(translation.openFile).not.toHaveBeenCalled()
    expect(await screen.findByText("Import paired source + target")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Import a translation into Jonah" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    const chooser = await screen.findByTestId("translation-chooser")
    expect(within(chooser).getByRole("combobox", { name: "Which file does it translate?" })).toHaveTextContent("Jonah")
  })

  it("keeps a held upload while another way is tried, and gives it back on Back", async () => {
    renderDialog({ translation: host({ activeFileId: null, activeFileCells: [] }) })
    await chooseTranslation()
    await dropFiles([new File(["Reference,Translation\nJON 1:1,a\n"], "JON-tatar.csv")])
    await pickFile("Jonah")
    fireEvent.click(otherWay(/^Paired translation/))
    expect(await screen.findByText("Opening Jonah…")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Back to choosing a file" }))
    expect(await screen.findByTestId("translation-held-file")).toHaveTextContent("JON-tatar.csv")
  })

  it("says so when the chosen file has no lines to fill", async () => {
    renderDialog({ translation: host({ activeFileCells: [] }) })
    await chooseTranslation()
    fireEvent.click(otherWay(/^eBible Corpus/))
    expect(await screen.findByText("Jonah has no lines yet, so there is nothing for a translation to fill.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(await screen.findByTestId("translation-chooser")).toBeInTheDocument()
  })
})
