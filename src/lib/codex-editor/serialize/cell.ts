import * as Y from "yjs";
import type { CodexCell, EditHistory } from "@/lib/codex-editor/types";
import type { CellHistoryEntry } from "@/lib/parsers/types";
import { getFragmentHtml } from "@/lib/richtext/translated-xml";
import { collapseToEditSessions, sessionToEditEntry } from "./edit-sessions";

/**
 * Serialize a single cell Y.Map back into the CodexCell JSON shape that gets
 * written to a `.codex` notebook on disk.
 *
 * Starts from `__source` (the original imported cell JSON stashed at import
 * time) so unknown fields — attachments, cellLabel, isLocked, data, etc. —
 * round-trip verbatim. Then it layers two kinds of edits on top:
 *
 *   1. `metadata.edits` gains a new EditHistory entry for every unsynced edit
 *      session found in the cell's `history` Y.Array (filtered by
 *      `__lastSyncedHistoryAt`).
 *
 *   2. `value` is re-emitted from the `translatedXml` Y.XmlFragment *only*
 *      when there are unsynced edits. If nothing changed since import, we keep
 *      the exact `value` bytes from `__source` — the HTML round-trip through
 *      our parser isn't a fixed point for every input, and preserving source
 *      bytes matters for the no-op commit case.
 */
export function serializeCell(cell: Y.Map<unknown>): CodexCell {
  const source = cell.get("__source") as CodexCell | undefined;
  if (!source) throw new Error("serializeCell: cell has no __source stash");
  const merged: CodexCell = JSON.parse(JSON.stringify(source));

  // Fold unsynced edit sessions in.
  const lastSynced = (cell.get("__lastSyncedHistoryAt") as number) ?? 0;
  const histArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined;
  const localEntries = (histArr?.toArray() ?? []).filter(
    (e) => Date.parse(e.timestamp) > lastSynced,
  );
  const newEdits: EditHistory[] = collapseToEditSessions(localEntries).map(sessionToEditEntry);

  if (newEdits.length > 0) {
    merged.metadata.edits = [...(merged.metadata.edits ?? []), ...newEdits];
    // There were local edits: re-emit value from the current fragment so the
    // written bytes reflect the user's latest state.
    const frag = cell.get("translatedXml") as Y.XmlFragment | undefined;
    if (frag) merged.value = getFragmentHtml(frag);
  }
  // Otherwise keep merged.value = source.value (byte-identical).

  return merged;
}
