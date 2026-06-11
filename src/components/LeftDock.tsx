/**
 * LeftDock.tsx — FRO-308 + FRO-320
 *
 * Collapsible, resizable left dock that replaces the fixed-width sidebar.
 * Hosts multiple surfaces as icon-tab switchers (like Claude's sidebar):
 *   - files   : project file list (was the old sidebar content)
 *   - chat    : AI chat (was a right-side Sheet drawer — FRO-320)
 *   - search  : search / parallel passages / find-replace panel
 *
 * Collapsed: renders a narrow rail of icon buttons only (no labels).
 * Expanded: shows the full panel at a user-draggable width.
 *
 * Width is persisted to localStorage per-project; defaults to 256px.
 * Min-width: 200px. Max-width: 520px.
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react"
import { Files, MessageSquare, Search, ChevronLeft, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DockTab = "files" | "chat" | "search"

export interface LeftDockProps {
  /** Slot rendered when "files" tab is active */
  filesPanel: ReactNode
  /** Slot rendered when "chat" tab is active */
  chatPanel: ReactNode
  /** Slot rendered when "search" tab is active */
  searchPanel: ReactNode
  /** Persist width / open-state per project */
  storageKey?: string
  /** Badge on the chat tab (e.g. unread) */
  chatBadge?: number
  /** Default tab to show when dock opens */
  defaultTab?: DockTab
  /** Externally controlled active tab (useful for "open chat" button in header) */
  activeTab?: DockTab | null
  onActiveTabChange?: (tab: DockTab | null) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_WIDTH = 200
const MAX_WIDTH = 520
const DEFAULT_WIDTH = 256

const TAB_META: { id: DockTab; icon: typeof Files; label: string }[] = [
  { id: "files", icon: Files, label: "Files" },
  { id: "chat", icon: MessageSquare, label: "Chat" },
  { id: "search", icon: Search, label: "Search" },
]

// ---------------------------------------------------------------------------
// LeftDock
// ---------------------------------------------------------------------------

export function LeftDock({
  filesPanel,
  chatPanel,
  searchPanel,
  storageKey,
  chatBadge,
  activeTab: controlledTab,
  onActiveTabChange,
}: LeftDockProps) {
  // ---- collapsed / expanded ------------------------------------------------
  // null = dock is collapsed (rail only), string = expanded with that tab active
  const [internalTab, setInternalTab] = useState<DockTab | null>("files")

  const activeTab = controlledTab !== undefined ? controlledTab : internalTab
  const setActiveTab = useCallback(
    (t: DockTab | null) => {
      if (onActiveTabChange) {
        onActiveTabChange(t)
      } else {
        setInternalTab(t)
      }
    },
    [onActiveTabChange],
  )

  const isOpen = activeTab !== null

  // ---- width ---------------------------------------------------------------
  const widthKey = storageKey ? `left-dock-width:${storageKey}` : null
  const [width, setWidth] = useState<number>(() => {
    if (!widthKey) return DEFAULT_WIDTH
    const saved = localStorage.getItem(widthKey)
    if (saved) {
      const n = parseInt(saved, 10)
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n
    }
    return DEFAULT_WIDTH
  })

  // Persist width
  useEffect(() => {
    if (!widthKey) return
    localStorage.setItem(widthKey, String(width))
  }, [widthKey, width])

  // ---- drag-to-resize ------------------------------------------------------
  const isDraggingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(0)

  const handleDragStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      isDraggingRef.current = true
      dragStartXRef.current = e.clientX
      dragStartWidthRef.current = width

      function onMove(ev: MouseEvent) {
        if (!isDraggingRef.current) return
        const delta = ev.clientX - dragStartXRef.current
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartWidthRef.current + delta))
        setWidth(next)
      }

      function onUp() {
        isDraggingRef.current = false
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
      }

      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    },
    [width],
  )

  // ---- toggle collapsed ↔ expanded -----------------------------------------
  function handleRailIconClick(tab: DockTab) {
    if (activeTab === tab) {
      // Clicking the active tab collapses the dock
      setActiveTab(null)
    } else {
      setActiveTab(tab)
    }
  }

  // ---- content map ---------------------------------------------------------
  const panels: Record<DockTab, ReactNode> = {
    files: filesPanel,
    chat: chatPanel,
    search: searchPanel,
  }

  return (
    <div
      className="relative flex h-full shrink-0 select-none"
      style={{ width: isOpen ? width : undefined }}
    >
      {/* ── Rail of icon tabs ── */}
      <div className="flex h-full w-10 shrink-0 flex-col items-center gap-1 pt-2">
        {TAB_META.map(({ id, icon: Icon, label }) => {
          const isActive = activeTab === id
          return (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={isActive}
              onClick={() => handleRailIconClick(id)}
              className={cn(
                "relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {id === "chat" && chatBadge != null && chatBadge > 0 && (
                <span
                  aria-label={`${chatBadge} unread`}
                  className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-[9px] text-primary-foreground"
                >
                  {chatBadge > 9 ? "9+" : chatBadge}
                </span>
              )}
            </button>
          )
        })}

        {/* Collapse / expand toggle at the bottom of the rail */}
        <button
          type="button"
          title={isOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-label={isOpen ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => setActiveTab(isOpen ? null : "files")}
          className="mt-auto mb-2 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
        >
          {isOpen ? (
            <ChevronLeft className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* ── Expanded panel body ── */}
      {isOpen && (
        <>
          {/* Panel content */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {activeTab && panels[activeTab]}
          </div>

          {/* Resize handle — right edge */}
          <div
            onMouseDown={handleDragStart}
            className={cn(
              "absolute right-0 top-0 h-full w-1 cursor-col-resize",
              "hover:bg-primary/30 active:bg-primary/50 transition-colors",
              "z-10",
            )}
            aria-hidden
            title="Drag to resize"
          />
        </>
      )}
    </div>
  )
}
