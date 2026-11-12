/**
 * AQU-1008 — the Biblica panel asks two independent questions.
 *
 * WHY: nothing in an IDML package says which Biblica title it is, so the person
 * importing answers — and a wrong answer silently produces the wrong cells (an
 * EBL guide read as study notes imports nothing at all). The panel therefore
 * has to keep the four titles mutually exclusive, default to study notes when
 * none is ticked, and hand the chosen edition to the importer. How finely to
 * cut the text is a separate question that every title answers the same way, so
 * it must stay independent of that choice rather than being cleared by it.
 *
 * The parsers themselves are covered alongside them under
 * `src/partner-integrations/biblica/**`, and the whole import journey in
 * `e2e/specs/partner-integrations/biblica/import-ebl.spec.ts`; this suite guards
 * only the panel → `importBiblicaStudyNotes` options wiring, and that the dialog
 * still reaches the panel now that it arrives through the partner registry.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { BiblicaImportOptions } from "@/partner-integrations/biblica/import"

const { importBiblicaStudyNotes } = vi.hoisted(() => ({
  importBiblicaStudyNotes: vi.fn(async (
    _file: File,
    _ctx: unknown,
    _onProgress: unknown,
    _options: BiblicaImportOptions,
  ) => ({ id: "file-ebl", name: "guide.idml" })),
}))

vi.mock("@/lib/import", () => ({
  importFile: vi.fn(),
  importEBible: vi.fn(),
  importMacula: vi.fn(),
  importTranslationNotes: vi.fn(),
  prepareParatextProject: vi.fn(),
  commitParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  prepareEBibleTargetImport: vi.fn(),
  applyEBibleTargetImport: vi.fn(),
  prepareImportFile: vi.fn(async () => ({ fileType: "txt", results: [] })),
  importPartnerNotes: vi.fn(),
}))
vi.mock("@/partner-integrations/biblica/import", () => ({ importBiblicaStudyNotes }))
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
// ScrollArea uses @base-ui/react which calls getAnimations() — not in happy-dom.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}))

import { ImportDialog } from "@/components/ImportDialog"

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "proj-aqu1008",
  username: "pm-user",
  sourceLanguage: "eng",
  targetLanguage: "fra",
  getToken: vi.fn(async () => "tok"),
  onImported: vi.fn(async () => undefined),
  projectFiles: [],
}

const TITLES = {
  treasureHunt: /This is a Treasure Hunt Bible file/i,
  reach4life: /This is a Reach 4 Life file/i,
  ebl: /This is an EBL file/i,
} as const

const SPLIT = /Split long notes into one cell per sentence/i

/**
 * The Biblica panel reaches the dialog through the partner registry as a lazy
 * import (AQU-1286), so it is not in the DOM in the same tick as the click —
 * wait for one of its controls before asserting on any of them.
 */
async function openBiblicaPanel(): Promise<void> {
  render(<ImportDialog {...baseProps} />)
  fireEvent.click(screen.getByText("Biblica Study Bible Notes"))
  await waitFor(() => expect(checkbox(SPLIT)).toBeInTheDocument())
}

function checkbox(name: RegExp): HTMLElement {
  return screen.getByRole("checkbox", { name })
}

/**
 * Each option is wrapped in its own `<label>`. happy-dom re-dispatches a
 * label-wrapped click back onto the control, so clicking the box itself would
 * toggle twice — click the label the way a person does.
 */
function toggle(name: RegExp): void {
  fireEvent.click(checkbox(name).closest("label")!)
}

/** Pick a file so the panel's Import button becomes usable. */
function chooseFile(): void {
  const input = document.querySelector('input[type="file"][accept=".idml"]')
  expect(input).not.toBeNull()
  const file = new File([new Uint8Array([80, 75, 3, 4])], "guide.idml")
  fireEvent.change(input as HTMLInputElement, { target: { files: [file] } })
}

function importedOptions(): BiblicaImportOptions {
  const call = importBiblicaStudyNotes.mock.calls[0]
  expect(call).toBeDefined()
  return call![3]
}

beforeEach(() => {
  importBiblicaStudyNotes.mockClear()
})

describe("AQU-1008 — Biblica edition choice", () => {
  it("starts on study notes with every title clear", async () => {
    await openBiblicaPanel()

    for (const name of Object.values(TITLES)) {
      expect(checkbox(name)).not.toBeChecked()
    }
    expect(checkbox(SPLIT)).not.toBeChecked()
  })

  it("keeps the titles mutually exclusive, whichever order they are ticked in", async () => {
    await openBiblicaPanel()

    toggle(TITLES.treasureHunt)
    expect(checkbox(TITLES.treasureHunt)).toBeChecked()

    toggle(TITLES.ebl)
    expect(checkbox(TITLES.ebl)).toBeChecked()
    expect(checkbox(TITLES.treasureHunt)).not.toBeChecked()
    expect(checkbox(TITLES.reach4life)).not.toBeChecked()

    toggle(TITLES.reach4life)
    expect(checkbox(TITLES.reach4life)).toBeChecked()
    expect(checkbox(TITLES.ebl)).not.toBeChecked()
  })

  it("sends the ticked title to the importer", async () => {
    await openBiblicaPanel()
    toggle(TITLES.ebl)
    chooseFile()

    fireEvent.click(screen.getByRole("button", { name: /^Import$/i }))

    await waitFor(() => expect(importBiblicaStudyNotes).toHaveBeenCalled())
    expect(importedOptions().edition).toBe("ebl")
  })

  it("falls back to study notes when the ticked title is cleared again", async () => {
    await openBiblicaPanel()
    toggle(TITLES.ebl)
    toggle(TITLES.ebl)
    expect(checkbox(TITLES.ebl)).not.toBeChecked()
    chooseFile()

    fireEvent.click(screen.getByRole("button", { name: /^Import$/i }))

    await waitFor(() => expect(importBiblicaStudyNotes).toHaveBeenCalled())
    expect(importedOptions().edition).toBe("study-notes")
  })

  it("keeps sentence splitting independent of the title, in both directions", async () => {
    await openBiblicaPanel()

    // Splitting is not one of the alternatives, so ticking it leaves the
    // titles alone...
    toggle(SPLIT)
    for (const name of Object.values(TITLES)) {
      expect(checkbox(name)).not.toBeChecked()
    }

    // ...and switching titles afterwards does not clear it.
    toggle(TITLES.ebl)
    toggle(TITLES.reach4life)
    expect(checkbox(SPLIT)).toBeChecked()

    chooseFile()
    fireEvent.click(screen.getByRole("button", { name: /^Import$/i }))

    await waitFor(() => expect(importBiblicaStudyNotes).toHaveBeenCalled())
    expect(importedOptions()).toMatchObject({
      edition: "reach4life",
      splitSentences: true,
    })
  })

  it("describes the guide, and names its file picker, once EBL is ticked", async () => {
    await openBiblicaPanel()
    expect(screen.getByText(/Choose study Bible IDML file/i)).toBeInTheDocument()

    toggle(TITLES.ebl)

    expect(screen.getByText(/Choose EBL IDML file/i)).toBeInTheDocument()
    expect(
      screen.getByText(/Equipping Biblical Leaders facilitator or participant guide/i),
    ).toBeInTheDocument()
  })
})
