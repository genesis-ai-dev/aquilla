import * as Y from "yjs";
import type { CodexCell, EditHistory, EditTypeValue, ValidationEntry } from "@/lib/codex-editor/types";
import { getFragmentHtml } from "@/lib/richtext/translated-xml";
import { snapshotEntry } from "@/lib/codex-editor/edits/yjs-helpers";

/**
 * Serialize a single cell Y.Map back into the CodexCell JSON shape for a
 * .codex notebook. Starts from __source to carry unknown fields (attachments,
 * isLocked, data, etc.) verbatim, then replaces metadata.edits with a fresh
 * emit from the live cell.edits Y.Array.
 *
 * Multi-author sessions are concatenated as "alice/bob" for compat with the
 * desktop app's EditHistory.author: string shape. When upstream supports
 * author: string[], drop the concat at this one call site.
 */
export function serializeCell(cell: Y.Map<unknown>): CodexCell {
  const source = cell.get("__source") as CodexCell | undefined;
  if (!source) throw new Error("serializeCell: cell has no __source stash");
  const merged: CodexCell = JSON.parse(JSON.stringify(source));

  const editsArr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined;
  const newEdits: EditHistory[] = [];
  if (editsArr) {
    for (let i = 0; i < editsArr.length; i++) {
      const snap = snapshotEntry(editsArr.get(i));
      const entry: EditHistory = {
        // TODO: drop concat once EditHistory.author upstream supports string[]
        author: snap.authors.length > 1 ? snap.authors.join("/") : (snap.authors[0] ?? ""),
        timestamp: snap.timestamp,
        type: snap.type as EditTypeValue,
        editMap: snap.editMap,
        value: snap.value,
      };
      if (snap.validatedBy.length > 0) entry.validatedBy = snap.validatedBy as ValidationEntry[];
      newEdits.push(entry);
    }
  }
  // Only set metadata.edits when the source had the field or we have new edits.
  // This preserves the round-trip contract for non-text cells (e.g. milestones)
  // that omit edits entirely — force-writing [] would change their on-disk shape.
  if (source.metadata.edits !== undefined || newEdits.length > 0) {
    merged.metadata.edits = newEdits;
  }

  // Re-emit value from the current fragment if we have any edits locally.
  // If cell.edits is empty AND fragment is empty, keep the source value bytes
  // (matches current no-op semantics — serialize must be a fixed point).
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined;
  if (frag && (newEdits.length > 0 || frag.length > 0)) {
    merged.value = getFragmentHtml(frag);
  }

  return merged;
}
