import * as Y from "yjs"
import type { EditTypeValue } from "@/lib/codex-editor/types"
import { SESSION_GAP_MS } from "./types"
import {
  appendEntry, editMapEquals, getEntryEditMap,
  entryHasAuthor, appendAuthor,
} from "./yjs-helpers"

export function getMetaEditsArray(meta: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
  let arr = meta.get("edits") as Y.Array<Y.Map<unknown>> | undefined
  if (!arr) {
    arr = new Y.Array<Y.Map<unknown>>()
    meta.set("edits", arr)
  }
  return arr
}

function resolveType(source: "human" | "llm"): EditTypeValue {
  return source === "llm" ? "llm-edit" : "user-edit"
}

/**
 * Record a commit on a notebook-level metadata field. Session-grouping is
 * identical to commitCellEdit (type+editMap within SESSION_GAP_MS extends in
 * place; author is NOT part of the grouping key) but we never seed
 * validatedBy — notebook metadata follows the desktop app's FileEditHistory
 * shape (no validators).
 */
export function commitMetaEdit(
  doc: Y.Doc,
  editMap: string[],
  value: unknown,
  username: string,
  source: "human" | "llm",
): void {
  const meta = doc.getMap("meta")
  const type = resolveType(source)
  const now = Date.now()

  doc.transact(() => {
    const arr = getMetaEditsArray(meta)
    const last = arr.length > 0 ? arr.get(arr.length - 1) : undefined

    if (last) {
      const lastTs = (last.get("timestamp") as number) ?? 0
      const lastType = last.get("type") as EditTypeValue
      const lastEditMap = getEntryEditMap(last)
      if (now - lastTs < SESSION_GAP_MS && lastType === type && editMapEquals(lastEditMap, editMap)) {
        last.set("value", value)
        last.set("timestamp", now)
        if (!entryHasAuthor(last, username)) appendAuthor(last, username)
        return
      }
    }

    appendEntry(arr, { authors: [username], timestamp: now, type, editMap, value })
  })
}
