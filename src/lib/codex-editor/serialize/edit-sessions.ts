import type { CellHistoryEntry } from "@/lib/parsers/types";
import type { EditHistory, EditTypeValue } from "@/lib/codex-editor/types";

const SESSION_GAP_MS = 5 * 60_000; // 5 min

export interface EditSession {
  author: string;
  source: "human" | "llm";
  validated: boolean;
  startTimestamp: number;
  endTimestamp: number;
  finalValue: string;
  entries: CellHistoryEntry[];
}

/**
 * Group contiguous history entries that look like a single "edit session" —
 * same author, same source, with gaps no larger than SESSION_GAP_MS. Used by
 * the codex-editor serializer to collapse noisy keystroke-level history into
 * a smaller set of EditHistory entries before writing back to disk.
 */
export function collapseToEditSessions(entries: CellHistoryEntry[]): EditSession[] {
  const sessions: EditSession[] = [];
  for (const entry of entries) {
    const ts = Date.parse(entry.timestamp);
    const last = sessions[sessions.length - 1];
    if (
      last
      && last.author === entry.author
      && last.source === entry.source
      && (ts - last.endTimestamp) <= SESSION_GAP_MS
    ) {
      last.endTimestamp = ts;
      last.finalValue = entry.value;
      last.validated = entry.validated;
      last.entries.push(entry);
    } else {
      sessions.push({
        author: entry.author,
        source: entry.source,
        validated: entry.validated,
        startTimestamp: ts,
        endTimestamp: ts,
        finalValue: entry.value,
        entries: [entry],
      });
    }
  }
  return sessions;
}

/**
 * Serialize a collapsed EditSession as a single EditHistory entry suitable for
 * writing to a .codex notebook's metadata.edits array.
 *
 * When the session is validated, emit a `validatedBy` array carrying a single
 * ValidationEntry for the session author. The desktop app reads `validatedBy`
 * (not the legacy boolean) to render validation state — if we drop it here,
 * validations made on the web never sync back.
 */
export function sessionToEditEntry(session: EditSession): EditHistory {
  const type: EditTypeValue = session.source === "llm" ? "llm-edit" : "user-edit";
  const entry: EditHistory = {
    author: session.author,
    timestamp: session.endTimestamp,
    type,
    editMap: ["value"],
    value: session.finalValue,
  };
  if (session.validated) {
    entry.validatedBy = [{
      username: session.author,
      creationTimestamp: session.endTimestamp,
      updatedTimestamp: session.endTimestamp,
      isDeleted: false,
    }];
  }
  return entry;
}
