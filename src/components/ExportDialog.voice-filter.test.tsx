// AQU-439 voice filter: the trigger must read "All voices" whenever no voice is
// picked. Base UI resolves the trigger label from the root's `items` and falls
// back to the raw value string, so the "" option rendered an empty trigger —
// the same defect the chapter picker had (ExportDialog.chapter-scope.test.tsx).
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({
  downloadBlob: vi.fn(),
}))
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: vi.fn(),
}))

import { useProjectCells } from "@/hooks/useProjectCells"

const mockProjectCells = vi.mocked(useProjectCells)

function voicedCell(id: string, castName: string): CellData {
  return {
    id,
    fileId: "f-txt",
    original: `source ${id}`,
    translated: `target ${id}`,
    context: "",
    group: "",
    metadata: { cast_name: castName },
  } as unknown as CellData
}

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  cells: [voicedCell("c1", "Narrator"), voicedCell("c2", "Peter")],
  projectId: "p1",
  projectName: "Voice filter",
  activeFileId: "f-txt",
  activeFileName: "notes.txt",
  activeFileType: "txt",
  projectFiles: [{ id: "f-txt", name: "notes.txt", type: "txt" }],
  targetLanguage: "es",
  getToken: async () => null,
}

// Base UI's Select commits on the keyboard path under happy-dom; a plain click
// on an option inside a modal Dialog does not (see AssignModal.test.tsx).
async function pickVoice(label: string) {
  const trigger = screen.getByRole("combobox", { name: /filter export by voice/i })
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: new RegExp(`^${label}$`) })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(document.activeElement ?? option, { key: "Enter" })
  await waitFor(() => expect(trigger.textContent).toContain(label))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — voice filter trigger label", () => {
  it("reads 'All voices' until a voice is chosen, and again once it is unpicked", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Markdown"))

    const trigger = screen.getByRole("combobox", { name: /filter export by voice/i })
    expect(trigger.textContent).toContain("All voices")

    await pickVoice("Narrator")
    expect(trigger.textContent).not.toContain("All voices")

    await pickVoice("All voices")
    expect(trigger.textContent).toContain("All voices")
  })
})
