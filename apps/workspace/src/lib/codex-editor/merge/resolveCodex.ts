// src/lib/codex-editor/merge/resolveCodex.ts
// Two-way merge for .codex / .source notebook files.
// Ported from codex-editor/src/projectManager/utils/merge/resolvers.ts:1108-1272
// minus the three-way/base parameter (we union edit ledgers; union is total).

import type {
  CodexCell, CodexNotebookFile, CodexNotebookMetadata, EditHistory,
} from "@/lib/codex-editor/types"
import { mergeTwoCellsUsingResolverLogic } from "./cells"
import { isValidValidationEntry } from "./validators"

function editKey(e: EditHistory): string {
  return `${e.timestamp}:${e.editMap.join(".")}:${JSON.stringify(e.value)}`
}

function unionEdits(a?: EditHistory[], b?: EditHistory[]): EditHistory[] {
  const byKey = new Map<string, EditHistory>()
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    if (!byKey.has(editKey(e))) byKey.set(editKey(e), e)
  }
  return [...byKey.values()].sort((x, y) => x.timestamp - y.timestamp)
}

function insertTheirsOnly(
  base: CodexCell[],
  theirsOrder: CodexCell[],
  theirsOnly: Map<string, CodexCell>,
): CodexCell[] {
  if (theirsOnly.size === 0) return base
  const baseIds = new Set(base.map(c => c.metadata.id))
  const theirIdxById = new Map(theirsOrder.map((c, i) => [c.metadata.id, i] as const))
  const out = [...base]

  const theirsOnlyInOrder = theirsOrder.filter(c => theirsOnly.has(c.metadata.id))

  for (const cell of theirsOnlyInOrder) {
    const idx = theirIdxById.get(cell.metadata.id)!
    let anchor: string | undefined
    let anchorSide: "before" | "after" = "after"
    for (let j = idx - 1; j >= 0; j--) {
      const id = theirsOrder[j].metadata.id
      if (baseIds.has(id)) { anchor = id; anchorSide = "after"; break }
    }
    if (!anchor) {
      for (let j = idx + 1; j < theirsOrder.length; j++) {
        const id = theirsOrder[j].metadata.id
        if (baseIds.has(id)) { anchor = id; anchorSide = "before"; break }
      }
    }

    if (!anchor) {
      out.push(cell)
    } else {
      const at = out.findIndex(c => c.metadata.id === anchor)
      const insertAt = anchorSide === "after" ? at + 1 : at
      out.splice(insertAt, 0, cell)
    }
    baseIds.add(cell.metadata.id)
  }
  return out
}

export async function resolveCodexTwoWay(
  ourBytes: string,
  theirBytes: string,
): Promise<string> {
  if (!ourBytes) return theirBytes
  if (!theirBytes) return ourBytes

  const ourNotebook: CodexNotebookFile = JSON.parse(ourBytes)
  const theirNotebook: CodexNotebookFile = JSON.parse(theirBytes)

  const ourMeta: CodexNotebookMetadata = ourNotebook.metadata ?? ({} as CodexNotebookMetadata)
  const theirMeta: CodexNotebookMetadata = theirNotebook.metadata ?? ({} as CodexNotebookMetadata)

  const mergedMeta: CodexNotebookMetadata = {
    ...ourMeta,
    ...theirMeta,
    edits: unionEdits(ourMeta.edits, theirMeta.edits),
  }

  const theirById = new Map<string, CodexCell>()
  for (const c of theirNotebook.cells) {
    if (c.metadata?.id) theirById.set(c.metadata.id, c)
  }

  const merged: CodexCell[] = []
  for (const ourCell of ourNotebook.cells) {
    const id = ourCell.metadata?.id
    if (!id) continue
    const theirCell = theirById.get(id)
    if (theirCell) {
      merged.push(mergeTwoCellsUsingResolverLogic(ourCell, theirCell))
      theirById.delete(id)
    } else {
      merged.push(ourCell)
    }
  }

  const withTheirsOnly = insertTheirsOnly(merged, theirNotebook.cells, theirById)

  for (const c of withTheirsOnly) {
    const edits = c.metadata?.edits
    if (!edits) continue
    for (const e of edits) {
      if (e.validatedBy) e.validatedBy = e.validatedBy.filter(isValidValidationEntry)
    }
  }

  return JSON.stringify(
    { ...ourNotebook, cells: withTheirsOnly, metadata: mergedMeta },
    null, 2,
  )
}
