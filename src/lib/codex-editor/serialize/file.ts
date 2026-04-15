import * as Y from "yjs";
import type { CodexNotebookFile, CodexNotebookMetadata } from "@/lib/codex-editor/types";
import { serializeCell } from "./cell";

/**
 * Serialize a whole `.codex` notebook Y.Doc back into its on-disk JSON shape.
 *
 * Cells are walked in the canonical order stored on the `order` Y.Array so we
 * preserve the original notebook ordering. Notebook-level metadata comes from
 * the `__source` stash placed on the meta map at import time; the only field
 * we currently let Phase 2 override is `videoUrl` (the editor exposes that
 * control). Unknown metadata fields pass through verbatim.
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

  // Override video fields if present (Phase 2 doesn't expose other meta edits).
  const videoUrl = meta.get("videoUrl") as string | undefined;
  if (videoUrl !== undefined) (fileMetadata as Record<string, unknown>).videoUrl = videoUrl;

  return { cells, metadata: fileMetadata };
}
