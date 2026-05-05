import * as Y from "yjs"
import type { EditTypeValue } from "@/lib/codex-editor/types"
import { SESSION_GAP_MS } from "./types"
import {
  getEditsArray,
  appendEntry,
  editMapEquals,
  getEntryEditMap,
  entryHasAuthor,
  appendAuthor,
  upsertValidator,
} from "./yjs-helpers"
import { enqueueCellCommitAfterValueEdit } from "@/lib/sync/cqrs-bridge"

function resolveType(source: "human" | "llm"): EditTypeValue {
  return source === "llm" ? "llm-edit" : "user-edit"
}

/**
 * Record a deliberate commit on a cell's value or metadata. Applies the
 * session-grouping rule: same type/editMap within SESSION_GAP_MS extends
 * the last entry in place (adding the committing user to `authors` if new);
 * otherwise a new entry is appended. Author is intentionally NOT part of
 * the grouping key — multi-author collaboration within one session is a
 * first-class case.
 *
 * For source="human" on a value-editMap, the author is auto-validated.
 * LLM commits never auto-validate, and metadata-editMap entries omit
 * validatedBy entirely (file/project-level edits are audit-only per the
 * desktop app's FileEditHistory shape).
 *
 * Wrapped in doc.transact so observers fire once per commit.
 */
export function commitCellEdit(
  doc: Y.Doc,
  cellId: string,
  username: string,
  editMap: string[],
  value: unknown,
  source: "human" | "llm",
  /**
   * Cross-file callers (batch replace, parallel passages) pass the target
   * fileId explicitly so the CQRS event isn't stamped with the bridge's
   * active editor file. Default uses the bridge.
   */
  fileIdOverride?: string,
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  const type = resolveType(source)
  const isValueEdit = editMap[0] === "value"
  const now = Date.now()

  doc.transact(() => {
    const arr = getEditsArray(cell)
    const last = arr.length > 0 ? arr.get(arr.length - 1) : undefined

    if (last) {
      const lastTimestamp = (last.get("timestamp") as number) ?? 0
      const lastType = last.get("type") as EditTypeValue
      const lastEditMap = getEntryEditMap(last)
      const withinWindow = now - lastTimestamp < SESSION_GAP_MS
      const sameSession =
        withinWindow && lastType === type && editMapEquals(lastEditMap, editMap)

      if (sameSession) {
        last.set("value", value)
        last.set("timestamp", now)
        if (!entryHasAuthor(last, username)) appendAuthor(last, username)
        if (source === "human" && isValueEdit) upsertValidator(last, username, now)
        return
      }
    }

    appendEntry(arr, {
      authors: [username],
      timestamp: now,
      type,
      editMap,
      value,
      seedValidator: source === "human" && isValueEdit ? username : undefined,
    })
  })

  if (isValueEdit) {
    enqueueCellCommitAfterValueEdit(doc, cellId, now, fileIdOverride)
  }
}
