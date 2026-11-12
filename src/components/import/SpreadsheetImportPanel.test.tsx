import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { SpreadsheetImportPanel } from "./SpreadsheetImportPanel"
import { importFile } from "@/lib/import"

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/lib/import", async (loadOriginal) => {
  const actual = await loadOriginal<typeof import("@/lib/import")>()
  return { ...actual, importFile: vi.fn() }
})

describe("SpreadsheetImportPanel", () => {
  beforeEach(() => {
    vi.mocked(importFile).mockReset()
    vi.mocked(importFile).mockResolvedValue({
      refs: [{
        id: "file-1",
        name: "pairs.csv",
        type: "csv",
        createdAt: "2026-07-20T00:00:00.000Z",
        cellCount: 1,
      }],
      speakerPairs: [],
    } as Awaited<ReturnType<typeof importFile>>)
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

    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
    expect(vi.mocked(importFile).mock.calls[0][1]).toMatchObject({
      projectId: "project-1",
      author: "alice",
      sourceLanguage: "en",
      targetLanguage: "fr",
      targetLang: "fr-CA",
    })
    expect(vi.mocked(importFile).mock.calls[0][2]).toMatchObject({
      fileType: "csv",
      results: [expect.objectContaining({ rawSourceFormat: "csv" })],
    })
  })

  // AQU-2120: the hand-off from the general dropzone used to drop the
  // collision screen's answer, so "Update existing" made a second pairs.csv.
  it("re-imports into the existing file the collision screen chose", async () => {
    render(
      <SpreadsheetImportPanel
        projectId="project-1"
        username="alice"
        sourceLanguage="en"
        targetLanguage="fr"
        getToken={vi.fn(async () => "token")}
        onImported={vi.fn()}
        onCancel={vi.fn()}
        initialFile={new File(["source,target\nHello,Bonjour\n"], "pairs.csv", { type: "text/csv" })}
        reimportTarget={{ id: "existing-pairs", name: "pairs.csv" }}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Map columns" }))
    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
    expect(vi.mocked(importFile).mock.calls[0][1].reimportFileIds?.get("pairs.csv")).toBe("existing-pairs")
  })

  // The sheet suffix is why this needs a name gate: the collision is resolved
  // against the workbook, but only one of its sheets is that existing file.
  it("imports fresh when the picked sheet is not the chosen file's sheet", async () => {
    render(
      <SpreadsheetImportPanel
        projectId="project-1"
        username="alice"
        sourceLanguage="en"
        targetLanguage="fr"
        getToken={vi.fn(async () => "token")}
        onImported={vi.fn()}
        onCancel={vi.fn()}
        initialFile={new File(["source,target\nHello,Bonjour\n"], "pairs.csv", { type: "text/csv" })}
        reimportTarget={{ id: "existing-other-sheet", name: "pairs.csv — Sheet2" }}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Map columns" }))
    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
    expect(vi.mocked(importFile).mock.calls[0][1].reimportFileIds).toBeUndefined()
  })

  it("starts column mapping for a spreadsheet handed off by the general uploader", async () => {
    render(
      <SpreadsheetImportPanel
        projectId="project-1"
        username="alice"
        sourceLanguage="en"
        targetLanguage="fr"
        getToken={vi.fn(async () => "token")}
        onImported={vi.fn()}
        onCancel={vi.fn()}
        initialFile={new File(["reference,source,type\nGEN 1:1,In the beginning,verse\n"], "verses.csv", { type: "text/csv" })}
      />,
    )

    expect(await screen.findByRole("button", { name: "Map columns" })).toBeInTheDocument()
    expect(screen.getByText("Content type")).toBeInTheDocument()
    expect(importFile).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Map columns" }))
    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
    expect(vi.mocked(importFile).mock.calls[0][2]).toMatchObject({
      results: [{
        strings: [{
          original: "In the beginning",
          translated: "",
          type: "verse",
          globalReferences: ["GEN 1:1"],
        }],
      }],
    })
  })

  it("surfaces a commit failure while the preview panel owns the screen", async () => {
    vi.mocked(importFile).mockRejectedValueOnce(new Error("source upload failed"))
    const onPreview = vi.fn()
    const onCommitError = vi.fn()
    render(
      <SpreadsheetImportPanel
        projectId="project-1"
        username="alice"
        sourceLanguage="en"
        targetLanguage="fr"
        getToken={vi.fn(async () => "token")}
        onImported={vi.fn()}
        onCancel={vi.fn()}
        onPreview={onPreview}
        onCommitError={onCommitError}
        initialFile={new File(["source,target\nHello,Bonjour\n"], "pairs.csv", { type: "text/csv" })}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Map columns" }))
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce())
    const commit = onPreview.mock.calls[0][1] as () => Promise<void>
    await commit()
    expect(onCommitError).toHaveBeenLastCalledWith("source upload failed")
  })

  it("retries finalization without uploading the spreadsheet twice", async () => {
    const onPreview = vi.fn()
    const onImported = vi.fn()
      .mockRejectedValueOnce(new Error("project registration failed"))
      .mockResolvedValueOnce(undefined)
    render(
      <SpreadsheetImportPanel
        projectId="project-1"
        username="alice"
        sourceLanguage="en"
        targetLanguage="fr"
        getToken={vi.fn(async () => "token")}
        onImported={onImported}
        onCancel={vi.fn()}
        onPreview={onPreview}
        initialFile={new File(["source,target\nHello,Bonjour\n"], "pairs.csv", { type: "text/csv" })}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Map columns" }))
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce())
    const commit = onPreview.mock.calls[0][1] as () => Promise<void>
    await commit()
    await commit()

    expect(importFile).toHaveBeenCalledOnce()
    expect(onImported).toHaveBeenCalledTimes(2)
  })
})
