// while a file hydrates, empty states when nothing is selected or the file
// has no cells yet. Mirrors the EditorTable's grid columns so there's no
// layout shift when real rows arrive.

import { FileText, FolderOpen, Sparkles, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/page"
import { Skeleton } from "@/components/ui/skeleton"
import type { CellAreaState } from "@/lib/editor/cell-area-state"

/** Matches EditorTable's gridCols — keep in sync if the table's columns change. */
const GRID_COLS = "grid-cols-[56px_1fr_1fr_56px]"

interface CellAreaPlaceholderProps {
  state: CellAreaState
  fileName?: string
  /** True when the project has no files at all (not just none selected). */
  hasFiles?: boolean
  /** FRO-149: true once the file list has been fetched from the server.
   *  Until this is true, we must NOT show the "No files yet — Import a file"
   *  CTA because projectFiles is transiently empty even on populated projects
   *  (the server fetch hasn't resolved yet). Showing the CTA too early risks a
   *  spurious "Import" click on a project that already has files. */
  filesLoaded?: boolean
  onImportClick?: () => void
}

export function CellAreaPlaceholder({
  state,
  fileName,
  hasFiles,
  filesLoaded,
  onImportClick,
}: CellAreaPlaceholderProps) {
  if (state.kind === "ready") return null
  if (state.kind === "no-file") return (
    <NoFileEmpty
      hasFiles={hasFiles}
      filesLoaded={filesLoaded}
      onImportClick={onImportClick}
    />
  )
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
          <div key={i} className={`bg-card grid ${GRID_COLS} items-start gap-3 rounded-2xl px-4 py-3`}>
            <Skeleton className="h-6 w-10" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-6 w-10" />
          </div>
        ))}
      </div>
      <div className="px-4 py-2 text-xs text-muted-foreground">
        {caption}
      </div>
    </div>
  )
}

function NoFileEmpty({
  hasFiles,
  filesLoaded,
  onImportClick,
}: {
  hasFiles?: boolean
  filesLoaded?: boolean
  onImportClick?: () => void
}) {
  // FRO-149: while the file list hasn't loaded yet, show the neutral "No file
  // selected" copy. We must NOT show "No files yet — Import a file" here because
  // projectFiles is transiently empty (server fetch still in flight) even on
  // projects that already have files — showing the CTA would risk a spurious
  // duplicate-import click. Only show the zero-files CTA once we KNOW the
  // project has actually been loaded and has no files.
  if (!filesLoaded) {
    return (
      <EmptyState
        variant="inline"
        className="h-full p-8"
        icon={FolderOpen}
        title="No file selected"
        description="Pick a file from the sidebar to start translating."
      />
    )
  }

  // When the project has no files at all the sidebar is empty, so "pick a
  // file from the sidebar" is wrong. Instead offer a direct import CTA.
  if (!hasFiles) {
    return (
      <EmptyState
        variant="inline"
        className="h-full p-8"
        icon={Upload}
        title="No files yet"
        description="Import a file to get started."
        action={
          onImportClick ? (
            <Button size="sm" onClick={onImportClick}>
              <Upload data-icon="inline-start" />
              Import a file
            </Button>
          ) : undefined
        }
      />
    )
  }
  return (
    <EmptyState
      variant="inline"
      className="h-full p-8"
      icon={FolderOpen}
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
      variant="inline"
      className="h-full p-8"
      icon={FileText}
      title={fileName ? `${fileName} is empty` : "This file has no cells yet"}
      description="Import content, or start typing in the first cell."
      action={
        onImportClick ? (
          <Button size="sm" onClick={onImportClick}>
            <Sparkles data-icon="inline-start" />
            Import content
          </Button>
        ) : undefined
      }
    />
  )
}
