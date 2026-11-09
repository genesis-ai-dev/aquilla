/**
 * Sidebar re-import opens on the importer that read the file, and Back returns
 * to the chooser without dropping the file being re-imported.
 *
 * A file read by the generic uploader has no Biblica profile, so the only way
 * to re-read it as EBL is to leave that uploader and pick Biblica — which then
 * has to ask which title it is, because nothing on the file says so.
 */

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { ImportDialog } from "./ImportDialog"

vi.mock("@/lib/sync/cells-read", () => ({
  fetchAllFileCells: vi.fn(async () => []),
}))

const onOpenChange = vi.fn()

function renderReimport(file: { importProfile?: string; corpusMarker?: string }) {
  return render(
    <ImportDialog
      open
      onOpenChange={onOpenChange}
      projectId="proj-reimport"
      username="dev"
      sourceLanguage="en"
      targetLanguage="fra"
      getToken={vi.fn(async () => null)}
      onImported={vi.fn(async () => undefined)}
      reimportTarget={{ fileId: "file-1", name: "Lesson.idml", ...file }}
    />,
  )
}

describe("sidebar re-import can switch importer", () => {
  it("opens the generic uploader, then Back reaches Biblica still re-importing this file", async () => {
    renderReimport({})
    expect(screen.getByRole("heading", { name: "Re-import Lesson.idml" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy()
    expect(screen.queryByText("Biblica Study Bible Notes")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Back to import types" }))

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole("heading", { name: "Re-import Lesson.idml" })).toBeTruthy()
    fireEvent.click(screen.getByText("Biblica Study Bible Notes"))

    expect(await screen.findByRole("group", { name: "Which Biblica title is this?" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Update this file" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Back to import types" })).toBeTruthy()
  })

  it("opens Biblica directly when that importer already read the file, with its edition locked", async () => {
    renderReimport({ importProfile: "builtin:biblica-ebl" })
    expect(await screen.findByRole("button", { name: "Choose EBL IDML file" })).toBeTruthy()
    expect(screen.queryByText("Which Biblica title is this?")).toBeNull()
    expect(screen.getByRole("button", { name: "Back to import types" })).toBeTruthy()
  })
})
