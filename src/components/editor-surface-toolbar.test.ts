import { describe, expect, it } from "vitest"
import type { OverflowMenuItem } from "@/components/OverflowMenu"
import { fileOptionsForAgentSurface } from "./editor-surface-toolbar"

describe("fileOptionsForAgentSurface", () => {
  it("keeps rename/move/export/delete and drops editor-only tools", () => {
    const items: OverflowMenuItem[] = [
      { id: "check-file", label: "Check file" },
      { id: "view-settings", label: "View settings" },
      { id: "next-unfinished", label: "Next unfinished" },
      { id: "diarize", label: "Diarize" },
      { id: "sep-file-actions", type: "separator" },
      { id: "file-rename", label: "Rename" },
      { id: "file-move", label: "Move to corpus" },
      { id: "file-export", label: "Export" },
      { id: "sep-file-delete", type: "separator" },
      { id: "file-delete", label: "Delete", destructive: true },
    ]

    expect(fileOptionsForAgentSurface(items).map((item) => item.id)).toEqual([
      "file-rename",
      "file-move",
      "file-export",
      "sep-file-delete",
      "file-delete",
    ])
  })

  it("returns nothing when the chapter menu has no file-identity actions", () => {
    expect(fileOptionsForAgentSurface([
      { id: "view-settings", label: "View settings" },
      { id: "sep-actions", type: "separator" },
    ])).toEqual([])
  })
})
