/**
 * Re-import of a Biblica file stays on this panel and commits through the
 * three sidebar choices, with the edition locked to the profile that created
 * the file.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import BiblicaPanel from "./BiblicaPanel"

vi.mock("./import", () => ({
  importBiblicaStudyNotes: vi.fn(async () => ({
    id: "file-1",
    name: "Genesis",
    type: "idml",
    createdAt: "2026-01-01T00:00:00.000Z",
    cellCount: 1,
  })),
  previewBiblicaStudyNotes: vi.fn(async () => [
    { id: "keep", original: "same", context: "c", group: "g", type: "text" },
    { id: "fresh", original: "new line", context: "c", group: "g", type: "text" },
  ]),
}))

import { importBiblicaStudyNotes } from "./import"

function renderPanel(reimport?: {
  fileId: string
  profileId?: string
  existingNames: readonly string[]
  existingSource?: readonly { cellId: string; value: string }[]
}) {
  return render(
    <I18nProvider>
      <BiblicaPanel
        projectId="p1"
        username="dev"
        getToken={async () => "tok"}
        onImported={vi.fn()}
        {...(reimport ? { reimport } : {})}
      />
    </I18nProvider>,
  )
}

function chooseFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(["idml"], "01GEN.idml", { type: "application/octet-stream" })
  fireEvent.change(input, { target: { files: [file] } })
}

describe("BiblicaPanel re-import", () => {
  it("keeps a fresh import on the single Import button", () => {
    renderPanel()
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Update this file" })).toBeNull()
    expect(screen.getByText("This is a Treasure Hunt Bible file")).toBeTruthy()
  })

  it("locks a study-notes re-import to the three choices", async () => {
    renderPanel({
      fileId: "file-notes",
      profileId: "builtin:biblica-study-notes",
      existingNames: ["Genesis"],
    })
    expect(screen.queryByText("This is a Treasure Hunt Bible file")).toBeNull()
    expect(screen.getByRole("button", { name: "Make a blank copy" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Make updated copy" })).toBeTruthy()
    chooseFile()
    fireEvent.click(screen.getByRole("button", { name: "Update this file" }))
    await vi.waitFor(() => {
      expect(importBiblicaStudyNotes).toHaveBeenCalledWith(
        expect.any(File),
        expect.objectContaining({
          sidebarReimport: {
            mode: "update",
            targetFileId: "file-notes",
            existingNames: ["Genesis"],
            suffix: "updated",
          },
        }),
        expect.any(Function),
        expect.objectContaining({ edition: "study-notes" }),
      )
    })
  })

  it("shows how many cells the chosen package would add and update", async () => {
    renderPanel({
      fileId: "file-notes",
      profileId: "builtin:biblica-study-notes",
      existingNames: ["Genesis"],
      existingSource: [{ cellId: "keep", value: "same" }],
    })
    chooseFile()
    const changes = await screen.findByTestId("reimport-changes")
    expect(changes).toHaveTextContent("1 cell added")
    expect(changes).toHaveTextContent("0 cells updated")
  })
})
