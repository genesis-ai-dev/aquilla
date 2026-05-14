// Renders the non-"ready" branches of the editor cell area: skeleton rows
// while a file hydrates, empty states when nothing is selected or the file
// has no cells yet. Mirrors the EditorTable's grid columns so there's no
// layout shift when real rows arrive.

import { FileText, FolderOpen, Sparkles } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import type { CellAreaState } from "@/lib/editor/cell-area-state"

/** Matches EditorTable's gridCols — keep in sync if the table's columns change. */
const GRID_COLS = "grid-cols-[56px_1fr_1fr_56px]"

interface CellAreaPlaceholderProps {
  state: CellAreaState
  fileName?: string
  onImportClick?: () => void
}

export function CellAreaPlaceholder({
  state,
  fileName,
  onImportClick,
}: CellAreaPlaceholderProps) {
  if (state.kind === "ready") return null
  if (state.kind === "no-file") return <NoFileEmpty />
  if (state.kind === "ready-empty") {
    return <ReadyEmpty fileName={fileName} onImportClick={onImportClick} />
  }
  // loading and syncing-empty both render skeleton rows. The syncing-empty
  // hint differs only by the caption below so the user knows why they're
  // still waiting.
  return (
    <SkeletonRows
      caption={
        state.kind === "syncing-empty"
          ? "Syncing from the cloud…"
          : "Opening file…"
      }
    />
  )
}

function SkeletonRows({ caption }: { caption: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-2 overflow-hidden p-4" aria-label={caption}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className={`grid ${GRID_COLS} gap-3 items-start`}>
            <Skeleton className="h-6 w-10" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-6 w-10" />
          </div>
        ))}
      </div>
      <div className="border-t px-4 py-2 text-xs text-muted-foreground">
        {caption}
      </div>
    </div>
  )
}

function NoFileEmpty() {
  return (
    <EmptyState
      icon={<FolderOpen className="h-10 w-10" aria-hidden />}
      title="No file selected"
      description="Pick a file from the sidebar to start translating."
    />
  )
}

function ReadyEmpty({
  fileName,
  onImportClick,
}: {
  fileName?: string
  onImportClick?: () => void
}) {
  return (
    <EmptyState
      icon={<FileText className="h-10 w-10" aria-hidden />}
      title={fileName ? `${fileName} is empty` : "This file has no cells yet"}
      description="Import content, or start typing in the first cell."
      action={
        onImportClick && (
          <button
            type="button"
            onClick={onImportClick}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-xs transition hover:bg-accent"
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            Import content
          </button>
        )
      }
    />
  )
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <div className="text-muted-foreground">{icon}</div>
        <h3 className="text-base font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  )
}
