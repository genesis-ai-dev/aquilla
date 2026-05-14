import * as Y from "yjs";
import type { CodexNotebookFile, CodexNotebookMetadata, EditHistory, EditTypeValue } from "@/lib/codex-editor/types";
import { serializeCell } from "./cell";
import { snapshotEntry } from "@/lib/codex-editor/edits/yjs-helpers";

/**
 * Serialize a whole .codex notebook Y.Doc back into its on-disk JSON shape.
 * Cell order comes from the `order` Y.Array. Notebook metadata starts from
 * meta.__source (import-time snapshot) with videoUrl overridden by the live
 * Y.Map value if present, and metadata.edits emitted fresh from meta.edits
 * Y.Array (FileEditHistory shape — no validatedBy).
 */
export function serializeFile(doc: Y.Doc): CodexNotebookFile {
  const cellsMap = doc.getMap("cells");
  const order = doc.getArray<string>("order").toArray();
  const meta = doc.getMap("meta");

  const cells = order.map((id) => {
    const yCell = cellsMap.get(id) as Y.Map<unknown> | undefined;
    if (!yCell) throw new Error(`serializeFile: ordered cell ${id} missing from cells map`);
    return serializeCell(yCell);
  });

  const sourceMeta = meta.get("__source") as CodexNotebookMetadata | undefined;
  if (!sourceMeta) throw new Error("serializeFile: meta has no __source stash");
  const fileMetadata: CodexNotebookMetadata = JSON.parse(JSON.stringify(sourceMeta));

  const videoUrl = meta.get("videoUrl") as string | undefined;
  if (videoUrl !== undefined) (fileMetadata as Record<string, unknown>).videoUrl = videoUrl;

  const editsArr = meta.get("edits") as Y.Array<Y.Map<unknown>> | undefined;
  if (editsArr) {
    const metaEdits: EditHistory[] = [];
    for (let i = 0; i < editsArr.length; i++) {
      const snap = snapshotEntry(editsArr.get(i));
      metaEdits.push({
        author: snap.authors.length > 1 ? snap.authors.join("/") : (snap.authors[0] ?? ""),
        timestamp: snap.timestamp,
        type: snap.type as EditTypeValue,
        editMap: snap.editMap,
        value: snap.value,
      });
    }
    // Only override if we have entries, OR source already had the field —
    // matches the same shape-preservation logic used in serializeCell.
    if (metaEdits.length > 0 || sourceMeta.edits !== undefined) {
      fileMetadata.edits = metaEdits;
    }
  }

  return { cells, metadata: fileMetadata };
}
