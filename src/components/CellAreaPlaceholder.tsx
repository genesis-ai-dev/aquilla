// Renders the non-"ready" branches of the editor cell area: skeleton rows
// while a file hydrates, empty states when nothing is selected or the file
// has no cells yet. Mirrors the EditorTable's grid columns so there's no
// layout shift when real rows arrive.

import type { ReactNode } from "react"
import { FileText, FolderOpen, Languages, Sparkles } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { CellAreaState } from "@/lib/editor/cell-area-state"

/** Matches EditorTable's gridCols — keep in sync if the table's columns change. */
const GRID_COLS = "grid-cols-[56px_1fr_1fr_56px]"

interface ProjectSummary {
  name: string
  sourceLanguage?: string
  targetLanguage?: string
  files: unknown[]
}

interface CellAreaPlaceholderProps {
  state: CellAreaState
  fileName?: string
  onImportClick?: () => void
  project?: ProjectSummary | null
}

export function CellAreaPlaceholder({
  state,
  fileName,
  onImportClick,
  project,
}: CellAreaPlaceholderProps) {
  if (state.kind === "ready") return null
  if (state.kind === "no-file") {
    return project ? (
      <ProjectOverviewCard project={project} onImportClick={onImportClick} />
    ) : (
      <NoFileEmpty />
    )
  }
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
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
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

function ProjectOverviewCard({
  project,
  onImportClick,
}: {
  project: ProjectSummary
  onImportClick?: () => void
}) {
  const fileCount = project.files.length
  const hasLanguages = project.sourceLanguage || project.targetLanguage

  return (
    <div className="flex h-full overflow-y-auto">
      <div className="w-full px-8 py-8">
        <Card className="w-full">
          <CardHeader className="pb-3 pt-2">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="text-xl font-semibold leading-snug">
                  {project.name}
                </CardTitle>
                {hasLanguages && (
                  <CardDescription className="mt-1 flex items-center gap-1.5">
                    <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {project.sourceLanguage || "?"} → {project.targetLanguage || "?"}
                  </CardDescription>
                )}
              </div>
              <div className="shrink-0 text-sm text-muted-foreground">
                {fileCount} file{fileCount !== 1 ? "s" : ""}
              </div>
            </div>
          </CardHeader>
          <CardContent className="pb-2">
            {fileCount === 0 ? (
              <p className="mb-4 text-sm text-muted-foreground">
                No files yet. Import a file to get started.
              </p>
            ) : (
              <p className="mb-4 text-sm text-muted-foreground">
                Select a file from the sidebar to start translating.
              </p>
            )}
            {onImportClick && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onImportClick}
                  className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-xs transition hover:bg-accent"
                >
                  <Sparkles className="h-4 w-4" aria-hidden />
                  Import a file
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
