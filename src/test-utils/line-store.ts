// A real CellStore holding the lines a test describes, built from server-shaped
// rows the way a file load builds it (AQU-2278). Each line's reference arrives
// as `canonicalRef`, a cue's timing as `startMs`/`endMs`, a split piece as the
// `aquillaOrigin` marker the quote split writes, a parked line as `hidden`.

import { CellStore } from "@/hooks/useActiveCellStore"
import { aquillaImportMetadata, normalizeTranslatableStrings } from "@/lib/import/normalized-manifest"
import type { FileType, TranslatableString } from "@/lib/parsers/types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { splitLineOrigin, userLineOrigin } from "@/lib/timeline/user-line-origin"

export interface TestLine {
  id: string
  ref?: string | null
  type?: string | null
  /** The source row's metadata bucket: an import envelope, a stored label. */
  metadata?: Record<string, unknown>
  /** A line someone added in the editor (no import envelope). */
  userAdded?: boolean
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

function sourceMetadata(line: TestLine): Record<string, unknown> | undefined {
  const origin = line.splitFrom ? splitLineOrigin(line.splitFrom) : line.userAdded ? userLineOrigin() : undefined
  if (!origin && !line.metadata) return undefined
  return { ...(line.metadata ?? {}), ...(origin ? { aquillaOrigin: origin } : {}) }
}

/** Lines as the importer stores them: parsed strings, normalized, with the
 *  `aquillaImport` envelope (and its `displayLabel`) on each source row. */
export function importedLines(strings: TranslatableString[], fileType: FileType): TestLine[] {
  const normalized = normalizeTranslatableStrings(strings, { fileName: `file.${fileType}`, fileType })
  return strings.map((str, i) => {
    const unit = normalized.units[i]
    return {
      id: str.id || `u${i}`,
      type: str.type ?? null,
      ref: unit.canonicalRef ?? null,
      text: unit.sourceText,
      metadata: { ...(str.metadata ?? {}), aquillaImport: aquillaImportMetadata(normalized, unit) },
      ...(unit.startMs !== undefined ? { startMs: unit.startMs } : {}),
    }
  })
}

export function lineRows(lines: readonly TestLine[]): CellRow[] {
  return lines.flatMap((line, index): CellRow[] => {
    const anchorCellId = index > 0 ? lines[index - 1].id : null
    const shared = {
      cellId: line.id,
      valueHtml: null,
      type: line.type === undefined ? "text" : line.type,
      anchorCellId,
      lastEditAt: 1,
      ...(line.startMs !== undefined ? { startMs: line.startMs, endMs: line.endMs ?? line.startMs + 1000 } : {}),
    }
    const text = line.text ?? `Line ${line.id}`
    const words = text.split(/\s+/).filter(Boolean).length
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
        wordCount: words,
        ...(sourceMetadata(line) ? { metadata: sourceMetadata(line) } : {}),
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

/** The words the app names lines with, in English. */
export const LINE_WORDS = { row: (label: string) => `row ${label}`, empty: "(empty line)" }

export function lineStore(lines: readonly TestLine[]): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId: "file-1", username: "alice", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(lineRows(lines), { full: true, maxServerSeq: 1 })
  return store
}
