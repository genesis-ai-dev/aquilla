import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { WorkspaceTab } from "@/hooks/useWorkspaceTabs"

interface FileMeta {
  id: string
  name: string
  originalName?: string
}

interface Props {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  files: readonly FileMeta[]
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function looksLikeUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}

/** Tab label for humans — never the internal file id. */
export function fileNameFor(files: readonly FileMeta[], fileId: string): string | null {
  const file = files.find((f) => f.id === fileId)
  if (!file) return null
  for (const candidate of [file.name, file.originalName]) {
    const trimmed = candidate?.trim()
    if (!trimmed || trimmed === fileId || looksLikeUuid(trimmed)) continue
    return trimmed
  }
  return "Untitled file"
}

export function TabStrip({ tabs, activeTabId, files, onActivate, onClose }: Props) {
  const visibleTabs = tabs.flatMap((tab) => {
    const name = fileNameFor(files, tab.fileId)
    return name ? [{ tab, name }] : []
  })
  if (visibleTabs.length === 0) return null
  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="relative z-10 flex items-stretch gap-1.5 overflow-x-auto border-b border-border px-2 py-1.5"
    >
      {visibleTabs.map(({ tab, name }) => {
        const active = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={cn(
              "group/tab relative flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => onActivate(tab.id)}
              className="flex max-w-[200px] items-center gap-1.5 truncate text-left"
              title={tab.sectionLabel ? `${name} · ${tab.sectionLabel}` : name}
            >
              <span className="truncate font-medium">{name}</span>
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
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 opacity-0 transition-all hover:text-foreground hover:shadow-neu-xs group-hover/tab:opacity-100 aria-[selected=true]:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
