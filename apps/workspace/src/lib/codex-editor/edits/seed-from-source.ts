import * as Y from "yjs"
import type { CodexCell, EditHistory, ValidationEntry } from "@/lib/codex-editor/types"
import { isValidValidationEntry } from "@/lib/codex-editor/merge/validators"
import { getEditsArray, appendEntry, upsertValidator, softDeleteValidator } from "./yjs-helpers"
import { getMetaEditsArray } from "./commit-meta-edit"

/**
 * Split a serialized author string back into the canonical authors array.
 * Multi-author sessions emit "alice/bob" for back-compat with the desktop
 * EditHistory.author: string shape; the split is the reverse.
 */
function parseAuthors(author: string): string[] {
  if (!author) return []
  return author.split("/").map(a => a.trim()).filter(Boolean)
}

/**
 * Rebuild a cell's Y.Array<Y.Map> edits from the (post-merge) __source. Runs
 * inside the caller's transact(). Always wipes first so a GitLab merge that
 * introduces new edits propagates correctly. Matches existing file-doc
 * behavior where cell.history is similarly rebuilt on rehydrate.
 */
export function seedCellEditsFromSource(cell: Y.Map<unknown>): void {
  const source = cell.get("__source") as CodexCell | undefined
  if (!source) return
  const arr = getEditsArray(cell)
  if (arr.length > 0) arr.delete(0, arr.length)

  const edits = source.metadata?.edits ?? []
  for (const e of edits) {
    const authors = parseAuthors(e.author)
    if (authors.length === 0) continue
    // appendEntry attaches the entry to the doc immediately so the
    // upsertValidator/softDeleteValidator calls below can write to the
    // nested validatedBy Y.Map.
    const entry = appendEntry(arr, {
      authors,
      timestamp: e.timestamp,
      type: e.type,
      editMap: e.editMap ?? [],
      value: e.value,
    })
    if (e.validatedBy && e.validatedBy.length > 0) {
      for (const raw of e.validatedBy as unknown[]) {
        if (!isValidValidationEntry(raw)) continue
        const v = raw as ValidationEntry
        upsertValidator(entry, v.username, v.creationTimestamp)
        if (v.updatedTimestamp > v.creationTimestamp) {
          if (v.isDeleted) softDeleteValidator(entry, v.username, v.updatedTimestamp)
          else upsertValidator(entry, v.username, v.updatedTimestamp)
        }
      }
    }
  }
}

interface MetaSource { edits?: EditHistory[] }

/**
 * Rebuild the notebook-level meta.edits Y.Array from __source.edits. Same
 * wipe+rebuild strategy as seedCellEditsFromSource. No validators — meta
 * edits follow the desktop FileEditHistory shape.
 */
export function seedMetaEditsFromSource(meta: Y.Map<unknown>): void {
  const source = meta.get("__source") as MetaSource | undefined
  if (!source) return
  const arr = getMetaEditsArray(meta)
  if (arr.length > 0) arr.delete(0, arr.length)
  const edits = source.edits ?? []
  for (const e of edits) {
    const authors = parseAuthors(e.author)
    if (authors.length === 0) continue
    appendEntry(arr, {
      authors,
      timestamp: e.timestamp,
      type: e.type,
      editMap: e.editMap ?? [],
      value: e.value,
    })
  }
}
