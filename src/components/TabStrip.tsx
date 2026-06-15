import type { ReactNode } from "react"
import { X } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { looksLikeUuid } from "@/lib/uuid"
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
  /** Non-file center surface (e.g. Rules) shown as a closable tab while its
   *  route is active, so the user has an obvious way back to the editor. */
  surfaceTab?: { label: string; onClose: () => void } | null
  /** Right-aligned slot for per-file view controls (e.g. the Text/Audio lens
   *  toggle) — they belong on the content row, not in the global header. */
  trailing?: ReactNode
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

export function TabStrip({ tabs, activeTabId, files, onActivate, onClose, surfaceTab, trailing }: Props) {
  const visibleTabs = tabs.flatMap((tab) => {
    const name = fileNameFor(files, tab.fileId)
    return name ? [{ tab, name }] : []
  })
  if (visibleTabs.length === 0 && !surfaceTab && !trailing) return null
  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="relative z-10 flex items-stretch gap-1.5 overflow-x-auto border-b border-border px-2 py-1.5"
    >
      {visibleTabs.map(({ tab, name }) => {
        const active = tab.id === activeTabId
        // Section ids that never got a human label come through as raw UUIDs —
        // suppress those rather than printing machine ids in the pill.
        const sectionLabel =
          tab.sectionLabel && !looksLikeUuid(tab.sectionLabel) ? tab.sectionLabel : null
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
            <AppTooltip content={sectionLabel ? `${name} · ${sectionLabel}` : name}>
              <button
                type="button"
                onClick={() => onActivate(tab.id)}
                className="flex max-w-[200px] items-center gap-1.5 truncate text-left"
              >
                <span className="truncate font-medium">{name}</span>
                {sectionLabel && (
                  <span className="truncate text-muted-foreground/80">· {sectionLabel}</span>
                )}
              </button>
            </AppTooltip>
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
      {surfaceTab && (
        <div
          role="tab"
          aria-selected
          className="group/tab relative flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-foreground transition-colors"
        >
          <span className="truncate font-medium">{surfaceTab.label}</span>
          <button
            type="button"
            onClick={surfaceTab.onClose}
            aria-label={`Close ${surfaceTab.label}`}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-all hover:text-foreground hover:shadow-neu-xs"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {trailing && (
        <div className="ml-auto flex shrink-0 items-center pl-2">{trailing}</div>
      )}
    </div>
  )
}
