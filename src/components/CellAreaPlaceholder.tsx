// while a file hydrates, empty states when nothing is selected or the file
// has no cells yet. Mirrors the EditorTable's grid columns so there's no
// layout shift when real rows arrive.

import { CloudOff, FileText, FolderOpen, RefreshCw, Sparkles, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LoadingTemplate } from "@/components/ui/loading-overlay"
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
  /** AQU-149: true once the file list has been fetched from the server.
   *  Until this is true, we must NOT show the "No files yet — Import a file"
   *  CTA because projectFiles is transiently empty even on populated projects
   *  (the server fetch hasn't resolved yet). Showing the CTA too early risks a
   *  spurious "Import" click on a project that already has files. */
  filesLoaded?: boolean
  onImportClick?: () => void
  onRetryClick?: () => void
}

export function CellAreaPlaceholder({
  state,
  fileName,
  hasFiles,
  filesLoaded,
  onImportClick,
  onRetryClick,
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
  if (state.kind === "load-error") {
    return <LoadError fileName={fileName} onRetryClick={onRetryClick} />
  }
  return <SkeletonRows />
}

function LoadError({
  fileName,
  onRetryClick,
}: {
  fileName?: string
  onRetryClick?: () => void
}) {
  return (
    <EmptyState
      variant="inline"
      className="h-full p-8"
      icon={CloudOff}
      title={fileName ? `Couldn't load ${fileName}` : "Couldn't load this file"}
      description="The file is still safe. Check your connection and try loading it again."
      action={
        onRetryClick ? (
          <Button size="sm" variant="outline" onClick={onRetryClick}>
            <RefreshCw data-icon="inline-start" />
            Retry loading file
          </Button>
        ) : undefined
      }
    />
  )
}

function SkeletonRows() {
  // AQU-819: this state is a plain read — the cells projection is being
  // fetched, or the socket hasn't finished connecting yet. Nothing is being
  // pushed or pulled on the user's behalf, so it must not say "Syncing";
  // that word is reserved for the outbox/edit-flush indicators.
  return (
    <LoadingTemplate
      label="Loading file from the cloud"
      className="h-full min-h-64"
      templateClassName="min-h-64"
      data-testid="cell-area-loading"
    >
      <div className="flex h-full min-h-64 flex-col">
        <div className="flex flex-1 flex-col gap-2 overflow-hidden p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={`bg-card grid ${GRID_COLS} items-start gap-3 rounded-2xl px-4 py-3`}>
              <Skeleton className="h-6 w-10" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-6 w-10" />
            </div>
          ))}
        </div>
      </div>
    </LoadingTemplate>
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
  // AQU-149: while the file list hasn't loaded yet, show the neutral "No file
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
