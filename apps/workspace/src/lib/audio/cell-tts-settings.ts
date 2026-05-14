import * as Y from "yjs"
import type { CellTtsSettings } from "@/lib/parsers/types"
import type { CodexCell } from "@/lib/codex-editor/types"

function cleanSettings(input: CellTtsSettings): CellTtsSettings | undefined {
  const next: CellTtsSettings = {}
  if (input.voiceId?.trim()) next.voiceId = input.voiceId.trim()
  return Object.keys(next).length > 0 ? next : undefined
}

export function setCellTtsSettings(
  doc: Y.Doc,
  cellId: string,
  patch: Partial<CellTtsSettings>,
): void {
  const cellsMap = doc.getMap("cells")
  const yCell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!yCell) throw new Error(`cell not found: ${cellId}`)

  doc.transact(() => {
    const prev = yCell.get("__source") as CodexCell | undefined
    const next: CodexCell = prev
      ? JSON.parse(JSON.stringify(prev))
      : {
          kind: 2 as const,
          languageId: "html",
          value: "",
          metadata: { id: cellId, type: "text" as const },
        }
    if (!next.metadata) next.metadata = { id: cellId, type: "text" }

    const merged = cleanSettings({
      ...(next.metadata.ttsSettings || {}),
      ...patch,
    })
    if (merged) next.metadata.ttsSettings = merged
    else delete next.metadata.ttsSettings

    yCell.set("__source", next)
  })
}
