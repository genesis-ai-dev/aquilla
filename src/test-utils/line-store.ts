// A real CellStore holding the lines a test describes, built from server-shaped
// rows the way a file load builds it (AQU-2278). Each line's reference arrives
// as `canonicalRef`, a cue's timing as `startMs`/`endMs`, a split piece as the
// `aquillaOrigin` marker the quote split writes, a parked line as `hidden`.

import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { splitLineOrigin } from "@/lib/timeline/user-line-origin"

export interface TestLine {
  id: string
  ref?: string | null
  type?: string
  text?: string
  translated?: string
  hidden?: boolean
  /** The verse row this piece was split off (AQU-1759). */
  splitFrom?: string
  startMs?: number
  endMs?: number
  validated?: boolean
  /** Who last wrote the translation; "alice" (the viewer) unless set. */
  lastEditor?: string | null
}

export function lineRows(lines: readonly TestLine[]): CellRow[] {
  return lines.flatMap((line, index): CellRow[] => {
    const anchorCellId = index > 0 ? lines[index - 1].id : null
    const shared = {
      cellId: line.id,
      valueHtml: null,
      type: line.type ?? "text",
      anchorCellId,
      lastEditAt: 1,
      ...(line.startMs !== undefined ? { startMs: line.startMs, endMs: line.endMs ?? line.startMs + 1000 } : {}),
    }
    const text = line.text ?? `Line ${line.id}`
    const translated = line.translated ?? ""
    return [
      {
        ...shared,
        side: "source",
        value: text,
        canonicalRef: line.ref ?? null,
        eventId: `${line.id}-source`,
        sourceEventId: null,
        lastEditor: null,
        validated: false,
        wordCount: text.split(/\s+/).length,
        ...(line.splitFrom ? { metadata: { aquillaOrigin: splitLineOrigin(line.splitFrom) } } : {}),
        ...(line.hidden ? { hidden: true } : {}),
      },
      {
        ...shared,
        side: "target",
        targetLang: "",
        value: translated,
        canonicalRef: line.ref ?? null,
        eventId: `${line.id}-target`,
        sourceEventId: `${line.id}-source`,
        lastEditor: line.lastEditor !== undefined ? line.lastEditor : "alice",
        validated: line.validated ?? false,
        wordCount: translated ? translated.split(/\s+/).length : 0,
      },
    ]
  })
}

export function lineStore(lines: readonly TestLine[]): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId: "file-1", username: "alice", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(lineRows(lines), { full: true, maxServerSeq: 1 })
  return store
}
