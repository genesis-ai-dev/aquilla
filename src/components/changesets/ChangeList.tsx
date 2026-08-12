// Shared per-cell change renderer for agent changesets (AQU approval UX).
// Used by the full approval page (/approve/:id) and, sample-sized, by the
// in-chat ChangesetCard so a reviewer can confirm without leaving the
// conversation. Data comes from auth-worker GET /api/v2/changesets/:id/approval.

export interface ChangesetChange {
  fileId: string
  fileName: string | null
  cellId: string
  laneId?: string
  canonicalRef: string | null
  source: string | null
  before: string | null
  after: string
}

export interface ChangesetChanges {
  total: number
  truncated: boolean
  items: ChangesetChange[]
}

export interface ChangesetImportPreview {
  fileName: string
  fileType: string
  totalCells: number
  sampleCells: { canonicalRef: string | null; content: string }[]
}

export function ChangeRow({ change }: { change: ChangesetChange }) {
  const label = [change.canonicalRef ?? change.cellId, change.laneId ? `lane ${change.laneId}` : null]
    .filter(Boolean)
    .join(" · ")
  return (
    <div className="space-y-1 rounded-md border bg-background p-2">
      <p className="text-xs font-medium text-muted-foreground">
        {change.fileName ? `${change.fileName} — ` : ""}
        {label}
      </p>
      {change.source && (
        <p className="text-xs text-muted-foreground italic whitespace-pre-wrap">{change.source}</p>
      )}
      {change.before !== null && (
        <p className="text-xs whitespace-pre-wrap text-destructive/80 line-through decoration-destructive/40">
          {change.before}
        </p>
      )}
      <p className="text-xs whitespace-pre-wrap text-emerald-700 dark:text-emerald-400">{change.after}</p>
    </div>
  )
}

export function ChangeList({
  changes,
  maxItems,
}: {
  changes: ChangesetChanges
  /** Render only the first N items (chat sample mode); omit for all fetched. */
  maxItems?: number
}) {
  const items = maxItems !== undefined ? changes.items.slice(0, maxItems) : changes.items
  const shownCount = items.length
  const hiddenCount = changes.total - shownCount
  return (
    <div className="space-y-1.5">
      {items.map((change) => (
        <ChangeRow key={`${change.fileId}:${change.cellId}:${change.laneId ?? ""}`} change={change} />
      ))}
      {hiddenCount > 0 && (
        <p className="text-xs text-muted-foreground">
          …and {hiddenCount} more {hiddenCount === 1 ? "change" : "changes"}.
        </p>
      )}
    </div>
  )
}

export function ImportPreviewView({ preview }: { preview: ChangesetImportPreview }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        Import {preview.fileName}
        {preview.fileType ? ` (${preview.fileType})` : ""} — {preview.totalCells}{" "}
        {preview.totalCells === 1 ? "cell" : "cells"}
      </p>
      {preview.sampleCells.map((cell, i) => (
        <div key={i} className="rounded-md border bg-background p-2">
          {cell.canonicalRef && (
            <p className="text-xs font-medium text-muted-foreground">{cell.canonicalRef}</p>
          )}
          <p className="text-xs whitespace-pre-wrap">{cell.content}</p>
        </div>
      ))}
      {preview.totalCells > preview.sampleCells.length && (
        <p className="text-xs text-muted-foreground">
          …and {preview.totalCells - preview.sampleCells.length} more cells.
        </p>
      )}
    </div>
  )
}
