import type { ReactNode } from "react"
import { FileText, Scale, X } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { looksLikeUuid } from "@/lib/uuid"
import type { WorkspaceTab } from "@/hooks/useWorkspaceTabs"

const TAB_WIDTH = "w-[200px]"

const TAB_BASE =
  `group/tab relative flex h-7 ${TAB_WIDTH} shrink-0 items-center gap-1 overflow-hidden rounded-lg border px-1.5 text-xs leading-none transition-all`

function tabClasses(active: boolean): string {
  return cn(
    TAB_BASE,
    active
      ? "border-border bg-card text-foreground"
      : "border-border/50 bg-card/60 text-muted-foreground hover:border-border hover:bg-card hover:text-foreground",
  )
}

const TAB_CLOSE_OVERLAY =
  "pointer-events-none absolute inset-y-0 z-[9] opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"

/** Always-on gradient — softens clipped label at the tab edge. */
function tabLabelFadeClasses(active: boolean): string {
  return cn(
    "pointer-events-none absolute inset-y-0 right-0 z-1 w-5 bg-gradient-to-l to-transparent group-hover/tab:opacity-0",
    active ? "from-card" : "from-card/60 group-hover/tab:from-card",
  )
}

/** On hover — gradient before the solid close zone. */
function tabCloseFadeClasses(active: boolean): string {
  return cn(
    TAB_CLOSE_OVERLAY,
    "right-5 w-4 bg-gradient-to-l to-transparent",
    active ? "from-card" : "from-card/60 group-hover/tab:from-card",
  )
}

/** On hover — solid patch under the ×. */
function tabCloseSolidClasses(active: boolean): string {
  return cn(
    TAB_CLOSE_OVERLAY,
    "right-0 w-5",
    active ? "bg-card" : "bg-card/60 group-hover/tab:bg-card",
  )
}

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
  surfaceTab?: { label: string; onClose: () => void } | null
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
      className="relative z-10 flex items-center gap-1 overflow-x-auto"
    >
      {visibleTabs.map(({ tab, name }) => {
        const active = tab.id === activeTabId
        const sectionLabel =
          tab.sectionLabel && !looksLikeUuid(tab.sectionLabel) ? tab.sectionLabel : null
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={tabClasses(active)}
          >
            <div className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden pr-1">
              <FileText
                aria-hidden
                className={cn(
                  "block h-3.5 w-3.5 shrink-0",
                  active ? "text-primary/80" : "text-muted-foreground/70",
                )}
              />
              <AppTooltip content={sectionLabel ? `${sectionLabel} · ${name}` : name}>
                <button
                  type="button"
                  onClick={() => onActivate(tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden p-0 text-left leading-none"
                >
                  {sectionLabel && (
                    <span className="shrink-0 whitespace-nowrap text-muted-foreground/80">
                      {sectionLabel}
                    </span>
                  )}
                  <span className="whitespace-nowrap font-medium">{name}</span>
                </button>
              </AppTooltip>
              <span aria-hidden className={tabLabelFadeClasses(active)} />
              <span aria-hidden className={tabCloseFadeClasses(active)} />
              <span aria-hidden className={tabCloseSolidClasses(active)} />
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
              aria-label={`Close ${name}`}
              className="absolute right-1 top-1/2 z-10 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 opacity-0 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
      {surfaceTab && (
        <div role="tab" aria-selected className={tabClasses(true)}>
          <div className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden pr-1">
            <Scale aria-hidden className="block h-3.5 w-3.5 shrink-0 text-primary/80" />
            <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-medium leading-none">
              {surfaceTab.label}
            </span>
            <span aria-hidden className={tabLabelFadeClasses(true)} />
            <span aria-hidden className={tabCloseFadeClasses(true)} />
            <span aria-hidden className={tabCloseSolidClasses(true)} />
          </div>
          <button
            type="button"
            onClick={surfaceTab.onClose}
            aria-label={`Close ${surfaceTab.label}`}
            className="absolute right-1 top-1/2 z-10 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 opacity-0 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
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
