// AQU-525 — a JSON source file is imported through an explicit key selection.
// WHY these assertions: (a) only the picked keys may become cells, because
// every other value is structure the user expects back untouched; (b) the
// original document must be retained as the file's source side-car, or the
// keyed export has nothing to write translations into and the round-trip
// promise is dead on arrival.
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { JsonImportPanel } from "./JsonImportPanel"
import { importFile } from "@/lib/import"

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/lib/import", async (loadOriginal) => {
  const actual = await loadOriginal<typeof import("@/lib/import")>()
  return { ...actual, importFile: vi.fn() }
})

const SOURCE = `{
  "app": {
    "title": "My App",
    "legal": "All rights reserved"
  },
  "version": 3
}
`

function jsonFile(content = SOURCE, name = "en.json"): File {
  return new File([content], name, { type: "application/json" })
}

function renderPanel(overrides: Partial<Parameters<typeof JsonImportPanel>[0]> = {}) {
  const onImported = vi.fn()
  render(
    <JsonImportPanel
      projectId="project-1"
      username="alice"
      sourceLanguage="en"
      targetLanguage="fr"
      targetLang="fr-CA"
      getToken={vi.fn(async () => "token")}
      onImported={onImported}
      onCancel={vi.fn()}
      initialFile={jsonFile()}
      {...overrides}
    />,
  )
  return { onImported }
}

describe("JsonImportPanel", () => {
  const user = userEvent.setup()

  beforeEach(() => {
    vi.mocked(importFile).mockReset()
    vi.mocked(importFile).mockResolvedValue({
      refs: [{
        id: "file-1",
        name: "en.json",
        type: "json",
        createdAt: "2026-10-12T00:00:00.000Z",
        cellCount: 1,
      }],
      speakerPairs: [],
    } as Awaited<ReturnType<typeof importFile>>)
  })

  it("asks which keys hold translatable text before importing anything", async () => {
    renderPanel()
    expect(await screen.findByText("Choose which keys to translate")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "app.title" })).toBeInTheDocument()
    expect(importFile).not.toHaveBeenCalled()
  })

  it("imports only the selected values, and keeps the original document as the side-car", async () => {
    const { onImported } = renderPanel()
    await user.click(await screen.findByRole("checkbox", { name: "app.legal" }))
    await user.click(screen.getByRole("button", { name: "Import selected keys" }))

    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
    expect(vi.mocked(importFile).mock.calls[0][1]).toMatchObject({
      projectId: "project-1",
      author: "alice",
      sourceLanguage: "en",
      targetLanguage: "fr",
      targetLang: "fr-CA",
    })
    const prepared = vi.mocked(importFile).mock.calls[0][2]
    expect(prepared?.fileType).toBe("json")
    const result = prepared!.results[0]
    // The unticked value never becomes a cell…
    expect(result.strings.map((s) => s.original)).toEqual(["My App"])
    // …and each cell carries its JSON path, which is what the keyed export
    // places the translation back by.
    expect(result.strings.map((s) => s.context)).toEqual(["app.title"])
    // …while the original bytes are retained for that export.
    expect(result.rawSourceFormat).toBe("json")
    expect(new TextDecoder().decode(result.rawBytes)).toBe(SOURCE)
    await waitFor(() => expect(onImported).toHaveBeenCalled())
  })

  it("hands the selected cells to the preview instead of committing when a preview is wired", async () => {
    const onPreview = vi.fn()
    renderPanel({ onPreview })
    await user.click(await screen.findByRole("button", { name: "Import selected keys" }))

    expect(onPreview).toHaveBeenCalledOnce()
    expect(onPreview.mock.calls[0][0][0].strings).toHaveLength(2)
    expect(importFile).not.toHaveBeenCalled()

    // The preview's confirm is what actually commits.
    await onPreview.mock.calls[0][1]()
    await waitFor(() => expect(importFile).toHaveBeenCalledOnce())
  })

  it("explains a JSON file with no translatable text rather than importing an empty file", async () => {
    renderPanel({ initialFile: jsonFile('{"n":1,"empty":""}', "numbers.json") })
    expect(await screen.findByText(/numbers\.json has no translatable text/)).toBeInTheDocument()
    expect(importFile).not.toHaveBeenCalled()
  })

  it("surfaces a failed commit and keeps the selection so a retry does not re-import", async () => {
    vi.mocked(importFile).mockRejectedValueOnce(new Error("Upload failed: 503"))
    renderPanel()
    await user.click(await screen.findByRole("button", { name: "Import selected keys" }))

    expect(await screen.findByText("Upload failed: 503")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Import selected keys" })).toBeInTheDocument()
  })
})
