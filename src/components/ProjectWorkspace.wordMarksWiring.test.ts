/**
 * AQU-2539: the wiring of a Word line's AI marks, pinned at its three call
 * sites (rendering ProjectWorkspace or the editors for this would need the
 * whole workspace). The behaviour itself is tested in
 * src/lib/completion/docx-marks.test.ts.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const read = (file: string) => readFileSync(join(__dirname, file), "utf8")

describe("Word AI marks wiring (AQU-2539)", () => {
  it("both completion commits read the answer by the cell the prompt was built from", () => {
    const source = read("ProjectWorkspace.tsx")
    const calls = source.match(/normalizeProtectedCompletion\([^)]*\)/g) ?? []
    const commits = calls.filter((call) => !/entry\.valueHtml/.test(call)) // the history restore is IDML-only
    expect(commits).toEqual([
      "normalizeProtectedCompletion(commitCell, text, { promptCell: cell })",
      "normalizeProtectedCompletion(liveCell, draft.text, { promptCell: draft.cell })",
    ])
  })

  it("the editor row and the extension editor show the preview without a marked line's tags", () => {
    expect(read("EditorTable.tsx")).toContain("previewText={markedPreviewText(cell, previews.get(cell.id))}")
    expect(read("tools/useExtensionEditorServices.ts")).toContain(
      "preview: markedPreviewText(args.store.getCellView(cellId), args.previews.get(cellId)) ?? null",
    )
  })
})
