import type { CellRow } from "./cells-read-types"
import type { OutboxRecord } from "./outbox"
import type { CqrsRawEvent } from "./outbox-types"

interface OverlayOptions {
  projectId?: string | null
  fileId?: string | null
}

type CellWriteKind =
  | "source.cell.create"
  | "source.cell.commit"
  | "target.cell.create"
  | "target.cell.commit"

type CellWriteEvent = CqrsRawEvent<CellWriteKind>

function isCellWriteEvent(event: CqrsRawEvent): event is CellWriteEvent {
  return (
    event.kind === "source.cell.create" ||
    event.kind === "source.cell.commit" ||
    event.kind === "target.cell.create" ||
    event.kind === "target.cell.commit"
  )
}

function wordCount(value: string): number {
  const trimmed = value.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

function key(cellId: string, side: CellRow["side"]): string {
  return `${side}\u001f${cellId}`
}

function findSibling(rows: CellRow[], cellId: string, side: CellRow["side"]): CellRow | undefined {
  return rows.find((row) => row.cellId === cellId && row.side === side)
}

function rowFromPendingEvent(
  event: CellWriteEvent,
  existing: CellRow | undefined,
  sibling: CellRow | undefined,
): CellRow | null {
  const side: CellRow["side"] = event.kind.startsWith("target.") ? "target" : "source"
  const payload = event.payload as {
    cellId?: string
    anchorCellId?: string | null
    value?: string
    valueHtml?: string
    type?: string
    canonicalRef?: string
    sourceEventId?: string | null
  }
  const cellId = event.cellId ?? payload.cellId
  if (!cellId || typeof payload.value !== "string") return null

  const valueHtml =
    payload.valueHtml !== undefined
      ? payload.valueHtml
      : existing?.valueHtml ?? null

  return {
    cellId,
    side,
    value: payload.value,
    valueHtml,
    type: payload.type ?? existing?.type ?? sibling?.type ?? null,
    canonicalRef: payload.canonicalRef ?? existing?.canonicalRef ?? sibling?.canonicalRef ?? null,
    anchorCellId: payload.anchorCellId ?? existing?.anchorCellId ?? sibling?.anchorCellId ?? null,
    eventId: event.id,
    sourceEventId:
      side === "target"
        ? payload.sourceEventId ?? existing?.sourceEventId ?? null
        : null,
    lastEditor: event.author ?? existing?.lastEditor ?? null,
    lastEditAt: event.clientTs ?? existing?.lastEditAt ?? Date.now(),
    validated: false,
    endorsementCount: existing?.endorsementCount ?? 0,
    wordCount: wordCount(payload.value),
  }
}

/**
 * Apply this browser's unflushed cell writes over the D1 read model.
 *
 * The outbox is the durable local save point before `/events` accepts an edit.
 * Without this overlay, a reload between enqueue and server acceptance makes
 * the editor hydrate from stale D1 rows and the user's queued edit appears to
 * vanish even though it is still waiting to sync.
 */
export function applyCellOutboxOverlay(
  rows: readonly CellRow[],
  pending: readonly OutboxRecord[],
  opts: OverlayOptions = {},
): CellRow[] {
  if (pending.length === 0) return rows.slice()

  let changed = false
  const out = rows.slice()
  const indexByKey = new Map<string, number>()
  for (let i = 0; i < out.length; i++) {
    indexByKey.set(key(out[i].cellId, out[i].side), i)
  }

  for (const record of pending) {
    const event = record.event
    if (!isCellWriteEvent(event)) continue
    if (opts.projectId && event.projectId !== opts.projectId) continue
    if (opts.fileId && event.fileId !== opts.fileId) continue

    const side: CellRow["side"] = event.kind.startsWith("target.") ? "target" : "source"
    const payload = event.payload as { cellId?: string }
    const cellId = event.cellId ?? payload.cellId
    if (!cellId) continue

    const rowKey = key(cellId, side)
    const existingIndex = indexByKey.get(rowKey)
    const existing = existingIndex === undefined ? undefined : out[existingIndex]
    const sibling = findSibling(out, cellId, side === "target" ? "source" : "target")
    const overlay = rowFromPendingEvent(event, existing, sibling)
    if (!overlay) continue

    if (existingIndex === undefined) {
      out.push(overlay)
      indexByKey.set(rowKey, out.length - 1)
    } else {
      out[existingIndex] = overlay
    }
    changed = true
  }

  return changed ? out : rows.slice()
}
