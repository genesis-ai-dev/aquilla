import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { SpreadsheetImportPanel } from "./SpreadsheetImportPanel"
import { emitParsedFile } from "@/lib/import"

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/lib/import", async (loadOriginal) => {
  const actual = await loadOriginal<typeof import("@/lib/import")>()
  return { ...actual, emitParsedFile: vi.fn() }
})

describe("SpreadsheetImportPanel", () => {
  beforeEach(() => {
    vi.mocked(emitParsedFile).mockReset()
    vi.mocked(emitParsedFile).mockResolvedValue({
      ref: {
        id: "file-1",
        name: "pairs.csv",
        type: "csv",
        createdAt: "2026-07-20T00:00:00.000Z",
        cellCount: 1,
      },
      speakerPairs: [],
    })
  })

  it("commits bilingual rows to the active target lane", async () => {
    render(
      <SpreadsheetImportPanel
        projectId="project-1"
        username="alice"
        sourceLanguage="en"
        targetLanguage="fr"
        targetLang="fr-CA"
        getToken={vi.fn(async () => "token")}
        onImported={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(["source,target\nHello,Bonjour\n"], "pairs.csv", { type: "text/csv" })] },
    })
    fireEvent.click(await screen.findByRole("button", { name: "Map columns" }))

    await waitFor(() => expect(emitParsedFile).toHaveBeenCalledOnce())
    expect(vi.mocked(emitParsedFile).mock.calls[0][2]).toMatchObject({
      projectId: "project-1",
      author: "alice",
      sourceLanguage: "en",
      targetLanguage: "fr",
      targetLang: "fr-CA",
    })
  })
})
