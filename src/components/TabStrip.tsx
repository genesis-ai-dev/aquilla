import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { WorkspaceTab } from "@/hooks/useWorkspaceTabs"

interface FileMeta {
  id: string
  name: string
  kind?: "source" | "target"
}

interface Props {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  files: readonly FileMeta[]
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
}

function fileFor(files: readonly FileMeta[], fileId: string): FileMeta | null {
  return files.find((f) => f.id === fileId) ?? null
}

export function TabStrip({ tabs, activeTabId, files, onActivate, onClose }: Props) {
  if (tabs.length === 0) return null
  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex items-stretch gap-px overflow-x-auto border-b bg-muted/30 px-2"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        const file = fileFor(files, tab.fileId)
        const name = file?.name ?? tab.fileId
        const kind = file?.kind
        const titleParts = [name]
        if (kind) titleParts.push(kind === "source" ? "Source" : "Target")
        if (tab.sectionLabel) titleParts.push(tab.sectionLabel)
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={cn(
              "group/tab relative flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs transition-colors",
              active
                ? "border-primary bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => onActivate(tab.id)}
              className="flex max-w-[220px] items-center gap-1.5 truncate text-left"
              title={titleParts.join(" · ")}
            >
              <span className="truncate font-medium">{name}</span>
              {kind && (
                <span
                  className={cn(
                    "shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide",
                    kind === "source"
                      ? "bg-muted text-muted-foreground"
                      : "bg-primary/10 text-primary",
                  )}
                >
                  {kind === "source" ? "src" : "tgt"}
                </span>
              )}
              {tab.sectionLabel && (
                <span className="truncate text-muted-foreground/80">· {tab.sectionLabel}</span>
              )}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
              aria-label={`Close ${name}`}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 aria-[selected=true]:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
