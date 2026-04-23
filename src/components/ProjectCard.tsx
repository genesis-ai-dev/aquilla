import { GitBranch, MoreVertical, Trash2, Undo2 } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface ProjectCardProps {
  project: ProjectRecord
  onClick: () => void
  /** Show the overflow menu with "Move to Trash". Hidden when the user
   * doesn't own the project. */
  canTrash?: boolean
  onTrash?: () => void
  /** Render a trashed-state card instead of the normal one. The click handler
   * is swapped for a Restore button. */
  variant?: "active" | "trashed"
  onRestore?: () => void
}

export function ProjectCard({
  project,
  onClick,
  canTrash,
  onTrash,
  variant = "active",
  onRestore,
}: ProjectCardProps) {
  const isGit = project.origin?.kind === "git"
  const isTrashed = variant === "trashed"

  return (
    <Card
      className={`${isTrashed ? "opacity-70" : "cursor-pointer hover:shadow-md"} transition-shadow`}
      onClick={isTrashed ? undefined : onClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-lg">{project.name}</CardTitle>
          <div className="flex items-center gap-1.5">
            {isGit && (
              <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                <GitBranch className="h-3 w-3" /> git
              </span>
            )}
            {!isTrashed && canTrash && onTrash && (
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Project actions"
                      onClick={(e) => e.stopPropagation()}
                    />
                  }
                >
                  <MoreVertical className="h-4 w-4" />
                </PopoverTrigger>
                <PopoverContent
                  className="w-44 p-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                    onClick={(e) => {
                      e.stopPropagation()
                      onTrash()
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    Move to Trash
                  </button>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {project.sourceLanguage} → {project.targetLanguage}
        </p>
        <p className="text-sm text-muted-foreground">
          {project.files.length} file{project.files.length !== 1 ? "s" : ""}
        </p>
        {isTrashed && (
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              Deleted
              {project.deletedBy ? ` by ${project.deletedBy}` : ""}
              {project.deletedAt ? ` · ${formatDate(project.deletedAt)}` : ""}
            </span>
            {onRestore && (
              <Button size="sm" variant="outline" onClick={onRestore}>
                <Undo2 className="mr-1 h-3.5 w-3.5" />
                Restore
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  } catch {
    return iso
  }
}
