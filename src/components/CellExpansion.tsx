// The drop-down panel that opens below a cell row when its chevron is clicked.
// Holds the rich, lower-frequency context that used to clutter the inline row:
// backtranslation, audio waveform + transcript, footnotes/issues, edit history.
//
// The expansion is a tab shell — each tab's content is passed as a slot so
// EditorRow can wire data (Yjs handles, callbacks) without this component
// growing 30 props.

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { cn } from "@/lib/utils"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

export interface CellExpansionTab {
  value: string
  icon: React.ReactNode
  /** Short label, shown on hover or in larger viewports. */
  label: string
  /** Tiny dot in the corner indicating the tab needs attention. */
  attentionDot?: "amber" | "emerald" | "red"
  /** Lazily renders the tab body. Only called for the active tab. */
  renderContent: () => React.ReactNode
  disabled?: boolean
}

interface Props {
  open: boolean
  /** Controlled current tab. Parent owns this so it can switch tabs in response
   *  to inline events (e.g. clicking a violation marker in the editor jumps to
   *  the Issues tab without closing the panel). */
  tab: string
  onTabChange: (next: string) => void
  tabs: CellExpansionTab[]
  /** Called when the user dismisses the panel via Esc. The chevron is owned
   *  by the rail and toggles open/close there. */
  onClose?: () => void
  /** Optional className for the outer wrapper. */
  className?: string
}

export function CellExpansion({
  open, tab, onTabChange, tabs, onClose, className,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const activeTab = tabs.find((t) => t.value === tab && !t.disabled)
    ?? tabs.find((t) => !t.disabled)
    ?? null
  const renderedTab = activeTab?.value ?? tab
  const enabledTabs = tabs.filter((t) => !t.disabled)

  function handleTabListKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (enabledTabs.length === 0) return

    const focusedValue = (e.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-cell-detail-tab-trigger]")
      ?.dataset.cellDetailTabTrigger
    const currentValue = focusedValue ?? renderedTab
    const currentIndex = Math.max(0, enabledTabs.findIndex((t) => t.value === currentValue))
    let nextIndex: number | null = null
    if (e.key === "ArrowRight" || e.key === "ArrowDown") nextIndex = (currentIndex + 1) % enabledTabs.length
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length
    else if (e.key === "Home") nextIndex = 0
    else if (e.key === "End") nextIndex = enabledTabs.length - 1
    if (nextIndex == null) return

    e.preventDefault()
    const nextValue = enabledTabs[nextIndex].value
    onTabChange(nextValue)
    window.requestAnimationFrame(() => {
      wrapperRef.current
        ?.querySelector<HTMLElement>(`[data-cell-detail-tab-trigger="${nextValue}"]`)
        ?.focus()
    })
  }

  // Esc to close. Listen on the wrapper so we don't compete with global Esc
  // handlers when the panel isn't focused.
  useEffect(() => {
    if (!open) return
    const el = wrapperRef.current
    if (!el) return
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose?.()
      }
    }
    el.addEventListener("keydown", handler)
    return () => el.removeEventListener("keydown", handler)
  }, [open, onClose])

  useEffect(() => {
    if (!open || !activeTab || activeTab.value === tab) return
    onTabChange(activeTab.value)
  }, [activeTab, onTabChange, open, tab])

  if (!open) return null

  return (
    <div
      ref={wrapperRef}
      className={cn(
        // Faint, bordered, contained block — indented under its row (by the
        // caller) and bounded with that row by the list divider, so it reads
        // as the row's child rather than a sibling of the next row.
        "mt-1.5 overflow-hidden rounded-lg border border-border bg-muted/40",
        // Entrance animation. CSS-only so we don't pull in a motion lib.
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1",
        className,
      )}
      data-state={open ? "open" : "closed"}
      // We don't want clicks inside the expansion to bubble up and trigger
      // row-level handlers (e.g. selection toggling).
      onClick={(e) => e.stopPropagation()}
    >
      <Tabs value={renderedTab} onValueChange={onTabChange} className="flex flex-col">
        <div className="flex items-center justify-between px-2 py-1.5">
          <TabsList onKeyDownCapture={handleTabListKeyDown}>
            {tabs.map((t) => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                disabled={t.disabled}
                attentionDot={t.attentionDot}
                data-cell-detail-tab-trigger={t.value}
              >
                <span className="inline-flex h-3 w-3 items-center justify-center">{t.icon}</span>
                <span className="hidden sm:inline">{t.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {activeTab && (
          <TabsContent key={activeTab.value} value={activeTab.value} className="px-3 py-3">
            <div data-cell-detail-tab={activeTab.value}>
              {activeTab.renderContent()}
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
