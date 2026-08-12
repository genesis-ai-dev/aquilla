import type { ReactNode } from "react"
import { FileText, Scale, X, type LucideIcon } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { looksLikeUuid } from "@/lib/uuid"
import type { WorkspaceTab } from "@/hooks/useWorkspaceTabs"
import { useT } from "@/lib/i18n/I18nProvider"

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

/** Non-file center surface (Rules, Agent, …) shown as a tab beside open files. */
export interface SurfaceTab {
  id: string
  label: string
  icon?: LucideIcon
  active: boolean
  onActivate: () => void
  onClose: () => void
}

interface Props {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  files: readonly FileMeta[]
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  surfaceTabs?: readonly SurfaceTab[]
  trailing?: ReactNode
}

/** Tab label for humans — never the internal file id. `untitledLabel` is the
 *  already-translated fallback shown when a file has no usable name. */
export function fileNameFor(
  files: readonly FileMeta[],
  fileId: string,
  untitledLabel = "Untitled file",
): string | null {
  const file = files.find((f) => f.id === fileId)
  if (!file) return null
  for (const candidate of [file.name, file.originalName]) {
    const trimmed = candidate?.trim()
    if (!trimmed || trimmed === fileId || looksLikeUuid(trimmed)) continue
    return trimmed
  }
  return untitledLabel
}

export function TabStrip({ tabs, activeTabId, files, onActivate, onClose, surfaceTabs = [], trailing }: Props) {
  const t = useT()
  const visibleTabs = tabs.flatMap((tab) => {
    const name = fileNameFor(files, tab.fileId, t("nav.tabStrip.untitledFile"))
    return name ? [{ tab, name }] : []
  })

  if (visibleTabs.length === 0 && surfaceTabs.length === 0 && !trailing) return null
  return (
    <div
      role="tablist"
      aria-label={t("nav.tabStrip.openFiles")}
      className="z-10 flex min-w-0 scroll-fade-x scroll-fade-8 items-center gap-1 overflow-x-auto overscroll-x-contain scrollbar-none"
    >
      {visibleTabs.map(({ tab, name }) => {
        const active = tab.id === activeTabId
        const sectionLabel =
          tab.sectionLabel && !looksLikeUuid(tab.sectionLabel) ? tab.sectionLabel : null
        // Prefer chapter/section over the book/file name so tabs stay short
        // (e.g. "GEN 1" instead of "GEN 1 Genesis").
        const label = sectionLabel ?? name
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
                  active ? "text-foreground" : "text-muted-foreground/70",
                )}
              />
              <AppTooltip content={sectionLabel ? `${sectionLabel} · ${name}` : name}>
                <button
                  type="button"
                  onClick={() => onActivate(tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden p-0 text-left leading-none"
                >
                  <span className="whitespace-nowrap font-medium">{label}</span>
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
              aria-label={t("nav.tabStrip.closeTab", { label })}
              className="absolute right-1 top-1/2 z-10 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 opacity-0 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
      {surfaceTabs.map((surfaceTab) => {
        const Icon = surfaceTab.icon ?? Scale
        const active = surfaceTab.active
        return (
          <div
            key={surfaceTab.id}
            role="tab"
            aria-selected={active}
            className={tabClasses(active)}
          >
            <div className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden pr-1">
              <Icon
                aria-hidden
                className={cn(
                  "block h-3.5 w-3.5 shrink-0",
                  active ? "text-foreground" : "text-muted-foreground/70",
                )}
              />
              <button
                type="button"
                onClick={surfaceTab.onActivate}
                className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden p-0 text-left leading-none"
              >
                <span className="whitespace-nowrap font-medium">{surfaceTab.label}</span>
              </button>
              <span aria-hidden className={tabLabelFadeClasses(active)} />
              <span aria-hidden className={tabCloseFadeClasses(active)} />
              <span aria-hidden className={tabCloseSolidClasses(active)} />
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                surfaceTab.onClose()
              }}
              aria-label={t("nav.tabStrip.closeTab", { label: surfaceTab.label })}
              className="absolute right-1 top-1/2 z-10 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 opacity-0 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
      {trailing && (
        <div className="ml-auto flex shrink-0 items-center pl-2">{trailing}</div>
      )}
    </div>
  )
}
