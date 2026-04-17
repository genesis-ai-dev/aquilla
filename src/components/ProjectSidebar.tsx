import type { FileReference } from "@/lib/parsers/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { HealthRing } from "./HealthRing"
import { MessageCircle } from "lucide-react"
import { groupByCorpus } from "@/lib/sidebar/group-by-corpus"

interface FileStats {
  translated: number
  validated: number
  total: number
}

interface ProjectSidebarProps {
  files: FileReference[]
  activeFileId: string | null
  onSelectFile: (fileId: string) => void
  fileHealth: Map<string, number>
  fileProgress: Map<string, FileStats>
  projectHealth: number
  openCommentCount?: Map<string, number>
}

export function ProjectSidebar({
  files, activeFileId, onSelectFile,
  fileHealth, fileProgress, projectHealth, openCommentCount,
}: ProjectSidebarProps) {
  const groups = groupByCorpus(files)
  const showHeaders = groups.length > 1 || (groups[0]?.label !== "Ungrouped")
  return (
    <ScrollArea className="h-full w-56 border-r">
      <div className="p-2">
        {/* Project health header */}
        <div className="mb-3 flex items-center gap-2 px-2">
          <HealthRing health={projectHealth} size={24} strokeWidth={3}>
            <span className="text-[8px] font-bold" style={{ color: projectHealth <= 33 ? "#ef4444" : projectHealth <= 66 ? "#f59e0b" : "#22c55e" }}>
              {projectHealth}
            </span>
          </HealthRing>
          <h3 className="text-sm font-medium text-muted-foreground">Files</h3>
        </div>

        {files.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">No files imported yet.</p>
        ) : (
          <div className="space-y-2">
            {groups.map((group) => (
              <details key={group.label} open className="group">
                {showHeaders && (
                  <summary className="cursor-pointer list-none px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </summary>
                )}
                <ul className="space-y-1">
                  {group.files.map((file) => {
                    const progress = fileProgress.get(file.id)
                    const health = fileHealth.get(file.id) ?? 0
                    const translatedPct = progress && progress.total > 0
                      ? Math.round((progress.translated / progress.total) * 100) : 0
                    const validatedPct = progress && progress.total > 0
                      ? Math.round((progress.validated / progress.total) * 100) : 0
                    return (
                      <li key={file.id}>
                        <button
                          className={cn(
                            "w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                            activeFileId === file.id && "bg-accent font-medium"
                          )}
                          onClick={() => onSelectFile(file.id)}
                        >
                          <div className="flex items-center gap-1.5">
                            <HealthRing health={health} size={16} strokeWidth={2} />
                            <span className="truncate">{file.name}</span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-blue-400/50 transition-all duration-500" style={{ width: `${translatedPct}%` }} />
                          </div>
                          <div className="-mt-1.5 h-1.5 w-full overflow-hidden rounded-full">
                            <div className="h-full rounded-full bg-green-500 transition-all duration-500" style={{ width: `${validatedPct}%` }} />
                          </div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {progress ? `${progress.translated}/${progress.total}` : `${file.cellCount} cells`}
                          </div>
                          {openCommentCount && (openCommentCount.get(file.id) || 0) > 0 && (
                            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-blue-500">
                              <MessageCircle className="h-2.5 w-2.5" />
                              {openCommentCount.get(file.id)} open
                            </div>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </details>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
