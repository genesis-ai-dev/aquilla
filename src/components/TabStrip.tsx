import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { FileText, Scale, X } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { looksLikeUuid } from "@/lib/uuid"
import type { WorkspaceTab } from "@/hooks/useWorkspaceTabs"
import { useT } from "@/lib/i18n/I18nProvider"

const SCROLL_EDGE_EPS = 1

/** Solid edge fades (like the tab label gradient) — mask-based scroll-fade
 *  is too subtle against sidebar chrome. */
const STRIP_EDGE_FADE =
  "pointer-events-none absolute inset-y-0 z-20 w-8 transition-opacity duration-150"

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
    "pointer-events-none absolute inset-y-0 end-0 z-1 w-5 bg-gradient-to-l to-transparent rtl:bg-gradient-to-r group-hover/tab:opacity-0",
    active ? "from-card" : "from-card/60 group-hover/tab:from-card",
  )
}

/** On hover — gradient before the solid close zone. */
function tabCloseFadeClasses(active: boolean): string {
  return cn(
    TAB_CLOSE_OVERLAY,
    "end-5 w-4 bg-gradient-to-l to-transparent rtl:bg-gradient-to-r",
    active ? "from-card" : "from-card/60 group-hover/tab:from-card",
  )
}

/** On hover — solid patch under the ×. */
function tabCloseSolidClasses(active: boolean): string {
  return cn(
    TAB_CLOSE_OVERLAY,
    "end-0 w-5",
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

export function TabStrip({ tabs, activeTabId, files, onActivate, onClose, surfaceTab, trailing }: Props) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollEdges = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    setCanScrollLeft(scrollLeft > SCROLL_EDGE_EPS)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - SCROLL_EDGE_EPS)
  }, [])

  const visibleTabs = tabs.flatMap((tab) => {
    const name = fileNameFor(files, tab.fileId, t("nav.tabStrip.untitledFile"))
    return name ? [{ tab, name }] : []
  })

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateScrollEdges()
    const ro = new ResizeObserver(updateScrollEdges)
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateScrollEdges, visibleTabs.length, surfaceTab, trailing])

  if (visibleTabs.length === 0 && !surfaceTab && !trailing) return null
  return (
    <div className="relative z-10 min-w-0">
      <div
        ref={scrollRef}
        role="tablist"
        aria-label={t("nav.tabStrip.openFiles")}
        onScroll={updateScrollEdges}
        className="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain scrollbar-none"
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
              <div className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden pe-1">
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
                    className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden p-0 text-start leading-none"
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
                className="absolute end-1 top-1/2 z-10 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 opacity-0 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
        {surfaceTab && (
          <div role="tab" aria-selected className={tabClasses(true)}>
            <div className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden pe-1">
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
              aria-label={t("nav.tabStrip.closeTab", { label: surfaceTab.label })}
              className="absolute end-1 top-1/2 z-10 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 opacity-0 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {trailing && (
          <div className="ms-auto flex shrink-0 items-center ps-2">{trailing}</div>
        )}
      </div>
      <span
        aria-hidden
        className={cn(
          STRIP_EDGE_FADE,
          "left-0 bg-linear-to-r from-sidebar from-30% to-transparent",
          canScrollLeft ? "opacity-100" : "opacity-0",
        )}
      />
      <span
        aria-hidden
        className={cn(
          STRIP_EDGE_FADE,
          "right-0 bg-linear-to-l from-sidebar from-30% to-transparent",
          canScrollRight ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  )
}
