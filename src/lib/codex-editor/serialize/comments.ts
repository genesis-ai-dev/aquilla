import * as Y from "yjs";
import type { CodexCommentsFile, CodexCommentThread } from "@/lib/codex-editor/types";

/**
 * Serialize comment threads across all notebook Y.Docs back into the
 * `.project/comments.json` shape.
 *
 * Phase 2 only round-trips threads that were present at import time — each
 * has its original JSON stashed under `__source` on the thread Y.Map.
 * Threads created locally in the editor are deferred to Phase 3+ and
 * silently skipped here.
 */
export function serializeComments(docs: Y.Doc[]): CodexCommentsFile {
  const out: CodexCommentsFile = {};
  for (const doc of docs) {
    const cellsMap = doc.getMap("cells");
    for (const cellId of cellsMap.keys()) {
      const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined;
      if (!cell) continue;
      const threadsArr = cell.get("threads") as Y.Array<Y.Map<unknown>> | undefined;
      if (!threadsArr) continue;
      for (let i = 0; i < threadsArr.length; i++) {
        const t = threadsArr.get(i);
        const source = t.get("__source") as CodexCommentThread | undefined;
        if (!source) continue; // new threads handled in Phase 3+
        out[source.id] = JSON.parse(JSON.stringify(source));
      }
    }
  }
  return out;
}
