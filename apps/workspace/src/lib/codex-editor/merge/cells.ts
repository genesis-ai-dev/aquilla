// src/lib/codex-editor/merge/cells.ts
// Vendored from codex-editor/src/projectManager/utils/merge/resolvers.ts:905-962,1002-1071
import type { CodexCell, EditHistory } from "@/lib/codex-editor/types"
import { mergeValidatedByLists } from "./validators"

export function applyEditToCell(cell: CodexCell, edit: EditHistory): void {
  let target: Record<string, unknown> = cell as unknown as Record<string, unknown>
  const path = edit.editMap.slice(0, -1)
  const leaf = edit.editMap[edit.editMap.length - 1]
  for (const segment of path) {
    if (target[segment] == null || typeof target[segment] !== "object") {
      target[segment] = {}
    }
    target = target[segment] as Record<string, unknown>
  }
  target[leaf] = edit.value
}

export function mergeTwoCellsUsingResolverLogic(a: CodexCell, b: CodexCell): CodexCell {
  // Start from the cell whose latest edit timestamp wins on simple fields.
  const merged: CodexCell = JSON.parse(JSON.stringify(a))
  const editsA = a.metadata.edits ?? []
  const editsB = b.metadata.edits ?? []
  const byKey = new Map<string, EditHistory>()
  const keyOf = (e: EditHistory) => `${e.timestamp}:${e.editMap.join(".")}:${JSON.stringify(e.value)}`
  for (const e of [...editsA, ...editsB]) {
    const k = keyOf(e)
    const prev = byKey.get(k)
    if (!prev) { byKey.set(k, e); continue }
    byKey.set(k, { ...prev, validatedBy: mergeValidatedByLists(prev.validatedBy, e.validatedBy) })
  }
  merged.metadata.edits = [...byKey.values()].sort((x, y) => x.timestamp - y.timestamp)

  // Apply the latest edit per editMap path so cell value reflects newest state.
  const byPath = new Map<string, EditHistory>()
  for (const e of merged.metadata.edits) {
    const k = e.editMap.join(".")
    const prev = byPath.get(k)
    if (!prev || e.timestamp > prev.timestamp) byPath.set(k, e)
  }
  for (const e of byPath.values()) applyEditToCell(merged, e)
  return merged
}
