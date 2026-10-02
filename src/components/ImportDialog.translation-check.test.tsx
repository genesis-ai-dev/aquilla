/**
 * AQU-1365: New source text asks "Is this a translation?" before any cell
 * exists.
 *
 * WHY each test matters:
 *  - The pilot's Tatar Jonah went through the source import and became a
 *    second Jonah source file (AC2). It must stop on a question first, and
 *    every answer must do what it says: into Jonah's translation with the same
 *    file (no second drop), an in-place update of Jonah's source, or a
 *    separate file.
 *  - A clear source upload must reach the preview exactly as before (AC3).
 *  - Nothing may be created on Back, and a file the collision screen already
 *    settled is not asked about twice.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react"

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
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
vi.mock("@/lib/parsers/paratext-project", () => ({ detectParatextProject: vi.fn(() => null) }))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn(), captureException: vi.fn() } }))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

import { ImportDialog, type TranslationImportHost } from "./ImportDialog"
import { importFile, prepareImportFile } from "@/lib/import"
import posthog from "@/lib/posthog"
import { IMPORT_STARTED, IMPORT_TRANSLATION_CHECK } from "@/lib/event-names"
import type { FileTargetCellRef } from "@/lib/import-file-target"
import { parseTextFormat } from "@/lib/parsers/parse-text-formats"
import { reimportKeysFor } from "@/lib/import/reimport-keys"

const JONAH_CELLS: FileTargetCellRef[] = [1, 2].map((verse) => ({
  cellId: `jonah-${verse}`,
  fileId: "jonah",
  canonicalRef: `JON 1:${verse}`,
  sourceEventId: `se-jonah-${verse}`,
  targetEventId: undefined,
  translated: "",
  original: `Jonah source ${verse}`,
}))

const FILES = [
  { id: "jonah", name: "Jonah", bookCode: "JON", type: "usfm" },
  { id: "ruth", name: "Ruth", bookCode: "RUT", type: "usfm" },
]

const JON_TATAR = "\\id JON Siberian Tatar (test)\n\\c 1\n\\v 1 Йона бер\n\\v 2 Йона ике\n"
const RUT_TATAR = "\\id RUT\n\\c 1\n\\v 1 Руфь бер\n"
const GEN_TATAR = "\\id GEN Siberian Tatar (test)\n\\c 1\n\\v 1 Башта\n"
const MRK_SOURCE = "\\id MRK\n\\c 1\n\\v 1 The beginning\n"
const LUK_SOURCE = "\\id LUK\n\\c 1\n\\v 1 Many have undertaken\n"
const PSA_ULT = "\\id PSA EN_ULT en_English_ltr unfoldingWord Literal Text\n\\c 1\n\\v 1 Blessed\n"

function usfm(text: string, name: string) {
  return new File([text], name, { type: "text/plain" })
}

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

function renderDialog(props: Partial<React.ComponentProps<typeof ImportDialog>> = {}) {
  const translation = props.translation ?? host()
  render(
    <ImportDialog
      open
      onOpenChange={vi.fn()}
      projectId="proj-1365"
      username="lead"
      sourceLanguage="English"
      targetLanguage="Siberian Tatar"
      getToken={vi.fn(async () => "tok")}
      onImported={vi.fn(async () => undefined)}
      existingFiles={FILES}
      translation={translation}
      {...props}
    />,
  )
  return { translation }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function upload(files: File[]) {
  fireEvent.click(screen.getByText("Upload files"))
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(input, "files", { value: files, configurable: true })
    fireEvent.change(input)
    for (let i = 0; i < 5; i++) await flush()
  })
}

async function confirmPreview() {
  const confirm = await screen.findByRole("button", { name: /confirm import/i })
  await act(async () => {
    fireEvent.click(confirm)
    for (let i = 0; i < 5; i++) await flush()
  })
}

async function answer(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }))
    for (let i = 0; i < 5; i++) await flush()
  })
}


function lastCheckEvent() {
  const calls = vi.mocked(posthog.capture).mock.calls.filter(([name]) => name === IMPORT_TRANSLATION_CHECK)
  return calls.at(-1)?.[1]
}

describe("AQU-1365: Is this a translation?", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The REAL parser's output: a parsed USFM upload carries no `bookCode`
    // (an earlier mock added one, which hid that the book check never fired
    // on a real upload).
    vi.mocked(prepareImportFile).mockImplementation(async (file: File) => ({
      fileType: "usfm",
      results: parseTextFormat({ fileType: "usfm", name: file.name, text: await file.text() }),
    }) as never)
    vi.mocked(importFile).mockResolvedValue({ refs: [{ fileId: "new-ref" } as never], speakerPairs: [] })
  })

  it("lets a clear source text through to the preview, as before", async () => {
    renderDialog()
    await upload([usfm(MRK_SOURCE, "MRK1-source.usfm")])
    expect(await screen.findByRole("button", { name: /confirm import/i })).toBeInTheDocument()
    expect(screen.queryByTestId("translation-check")).not.toBeInTheDocument()
  })

  it("doesn't mistake a source text that names the source language", async () => {
    renderDialog()
    await upload([usfm(PSA_ULT, "PSA1-source-ult.usfm")])
    expect(await screen.findByRole("button", { name: /confirm import/i })).toBeInTheDocument()
  })

  it("stops the Tatar Jonah and puts it into Jonah's translation with the same file", async () => {
    const { translation } = renderDialog()
    await upload([usfm(JON_TATAR, "JON-tatar.usfm")])
    expect(await screen.findByRole("heading", { name: "Jonah is already in this project" })).toBeInTheDocument()
    const check = screen.getByTestId("translation-check")
    expect(check).toHaveTextContent(
      "JON-tatar.usfm is for Jonah, and Jonah is already in this project. Is it a translation of Jonah, or a new version of Jonah's source text?",
    )
    expect(check).toHaveTextContent("It also says it's in Siberian Tatar, the language you translate into.")

    await answer("Put it into Jonah as its translation")
    expect(await screen.findByText(/review matches/i)).toBeInTheDocument()
    expect(screen.getByText(/2 matched/i)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Import a translation into Jonah" })).toBeInTheDocument()
    expect(translation.openFile).not.toHaveBeenCalled()
    expect(importFile).not.toHaveBeenCalled()
    expect(lastCheckEvent()).toMatchObject({ signal: "both", file_count: 1, flagged_count: 1, choice: "translation" })
    expect(posthog.capture).toHaveBeenCalledWith(IMPORT_STARTED, expect.objectContaining({
      import_type: "file-target", entry: "translation-check",
    }))
  })

  it("opens the other file first when the translation is for a file that isn't open", async () => {
    const { translation } = renderDialog()
    await upload([usfm(RUT_TATAR, "RUT-tatar.usfm")])
    const check = await screen.findByTestId("translation-check")
    expect(check).not.toHaveTextContent("It also says")
    await answer("Put it into Ruth as its translation")
    expect(translation.openFile).toHaveBeenCalledWith("ruth")
    expect(await screen.findByText("Opening Ruth…")).toBeInTheDocument()
  })

  it("updates Jonah's source text in place", async () => {
    renderDialog()
    await upload([usfm(JON_TATAR, "JON-tatar.usfm")])
    await screen.findByTestId("translation-check")
    await answer("Update Jonah's source text")
    await confirmPreview()
    expect(importFile).toHaveBeenCalledTimes(1)
    const ctx = vi.mocked(importFile).mock.calls[0][1]
    // Resolved the way `emitParsedFile` resolves it, from the parsed result
    // the import commits (which has no book code, only its name).
    const [result] = parseTextFormat({ fileType: "usfm", name: "JON-tatar.usfm", text: JON_TATAR })
    expect(Object.keys(result)).not.toContain("bookCode")
    const resolved = reimportKeysFor(result).map((key) => ctx.reimportFileIds?.get(key)).find(Boolean)
    expect(resolved).toBe("jonah")
    expect(lastCheckEvent()).toMatchObject({ choice: "update" })
  })

  it("imports it as a separate file when asked to", async () => {
    renderDialog()
    await upload([usfm(JON_TATAR, "JON-tatar.usfm")])
    await screen.findByTestId("translation-check")
    await answer("Import it as a separate file")
    await confirmPreview()
    expect(importFile).toHaveBeenCalledTimes(1)
    expect(vi.mocked(importFile).mock.calls[0][1].reimportFileIds?.size ?? 0).toBe(0)
  })

  it("asks only about the language for a book the project doesn't have, and hands it to the file choice", async () => {
    renderDialog()
    await upload([usfm(GEN_TATAR, "GEN1-tatar.usfm")])
    expect(await screen.findByRole("heading", { name: "This looks like a translation" })).toBeInTheDocument()
    expect(screen.getByTestId("translation-check")).toHaveTextContent(
      "GEN1-tatar.usfm says it's in Siberian Tatar, the language you translate into.",
    )
    await answer("Choose the file it translates")
    expect(await screen.findByTestId("translation-chooser")).toBeInTheDocument()
    expect(screen.getByTestId("translation-held-file")).toHaveTextContent("GEN1-tatar.usfm")
    expect(screen.getByRole("radio", { name: /^A translation/ })).toHaveAttribute("aria-checked", "true")
    expect(importFile).not.toHaveBeenCalled()
  })

  it("imports the rest of a batch without the files that look like translations", async () => {
    renderDialog()
    const luke = usfm(LUK_SOURCE, "LUK1-source.usfm")
    await upload([luke, usfm(JON_TATAR, "JON-tatar.usfm")])
    expect(await screen.findByRole("heading", { name: "Some of these look like translations" })).toBeInTheDocument()
    expect(screen.getByTestId("translation-check")).toHaveTextContent(
      "1 of these files may be a translation of a file already in this project: JON-tatar.usfm.",
    )
    await answer("Leave it out and import the rest")
    await confirmPreview()
    expect(importFile).toHaveBeenCalledTimes(1)
    expect(vi.mocked(importFile).mock.calls[0][0]).toBe(luke)
    expect(lastCheckEvent()).toMatchObject({ file_count: 2, flagged_count: 1, choice: "leave-out" })
  })

  it("offers only to import them all when every file in the batch looks like a translation", async () => {
    renderDialog()
    await upload([usfm(JON_TATAR, "JON-tatar.usfm"), usfm(RUT_TATAR, "RUT-tatar.usfm")])
    await screen.findByTestId("translation-check")
    expect(screen.queryByRole("button", { name: /leave/i })).not.toBeInTheDocument()
    await answer("Import them all as new source files")
    await confirmPreview()
    expect(importFile).toHaveBeenCalledTimes(2)
  })

  it("goes back to the upload with nothing created", async () => {
    renderDialog()
    await upload([usfm(JON_TATAR, "JON-tatar.usfm")])
    await screen.findByTestId("translation-check")
    await answer("Back to file selection")
    expect(screen.queryByTestId("translation-check")).not.toBeInTheDocument()
    expect(document.querySelector('input[type="file"]')).toBeInTheDocument()
    expect(importFile).not.toHaveBeenCalled()
    expect(lastCheckEvent()).toMatchObject({ choice: "back" })
  })

  it("can't name one destination when two files hold the book, so it offers the file choice", async () => {
    renderDialog({
      translation: host({ files: [...FILES, { id: "jonah-2", name: "Jonah", bookCode: "JON", type: "usfm" }] }),
    })
    await upload([usfm(JON_TATAR, "JON-tatar.usfm")])
    const check = await screen.findByTestId("translation-check")
    expect(check).toHaveTextContent("this project already has more than one Jonah")
    expect(within(check).queryByRole("button", { name: /put it into/i })).not.toBeInTheDocument()
    expect(within(check).queryByRole("button", { name: /update/i })).not.toBeInTheDocument()
    expect(within(check).getByRole("button", { name: "Choose the file it translates" })).toBeInTheDocument()
  })

  it("doesn't ask again about a file the collision screen already settled", async () => {
    renderDialog({ existingFiles: [{ id: "jonah", name: "JON-tatar.usfm", bookCode: "JON" }] })
    await upload([usfm(JON_TATAR, "JON-tatar.usfm")])
    await waitFor(() => expect(screen.getByText(/re-import detected/i)).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }))
      for (let i = 0; i < 5; i++) await flush()
    })
    expect(await screen.findByRole("button", { name: /confirm import/i })).toBeInTheDocument()
    expect(screen.queryByTestId("translation-check")).not.toBeInTheDocument()
  })

  it("doesn't check at all without the translation path", async () => {
    renderDialog({ translation: undefined })
    // `translation: undefined` in the spread above overrides the default host.
    await upload([usfm(JON_TATAR, "JON-tatar.usfm")])
    expect(await screen.findByRole("button", { name: /confirm import/i })).toBeInTheDocument()
  })
})
