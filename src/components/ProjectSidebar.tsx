import type { FileReference } from "@/lib/parsers/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

interface ProjectSidebarProps {
  files: FileReference[]
  activeFileId: string | null
  onSelectFile: (fileId: string) => void
}

export function ProjectSidebar({
  files,
  activeFileId,
  onSelectFile,
}: ProjectSidebarProps) {
  return (
    <ScrollArea className="h-full w-56 border-r">
      <div className="p-2">
        <h3 className="mb-2 px-2 text-sm font-medium text-muted-foreground">
          Files
        </h3>
        {files.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">
            No files imported yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {files.map((file) => (
              <li key={file.id}>
                <button
                  className={cn(
                    "w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                    activeFileId === file.id && "bg-accent font-medium"
                  )}
                  onClick={() => onSelectFile(file.id)}
                >
                  <div className="truncate">{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {file.cellCount} cells
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ScrollArea>
  )
}
