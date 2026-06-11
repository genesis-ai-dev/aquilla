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
 * Tab rail position (left vs top) is a user preference — see Preferences.
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
import {
  Files,
  MessageSquare,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ReportProblemButton } from "@/components/ReportProblemButton/ReportProblemButton"
import { VersionTag } from "@/components/VersionBadge"
import { useDockRailPosition } from "@/hooks/useDockRailPosition"

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
const RAIL_WIDTH = 40

const TAB_META: { id: DockTab; icon: typeof Files; label: string }[] = [
  { id: "files", icon: Files, label: "Files" },
  { id: "chat", icon: MessageSquare, label: "Chat" },
  { id: "search", icon: Search, label: "Search" },
]

// ---------------------------------------------------------------------------
// Tab rail
// ---------------------------------------------------------------------------

interface TabRailProps {
  activeTab: DockTab | null
  chatBadge?: number
  onTabClick: (tab: DockTab) => void
  orientation: "left" | "top"
}

function TabRail({ activeTab, chatBadge, onTabClick, orientation }: TabRailProps) {
  const isTop = orientation === "top"

  return (
    <div
      className={cn(
        isTop
          ? "mx-2 mt-2 flex min-w-0 items-center gap-0.5 rounded-full p-1 neu-inset"
          : "flex h-full w-10 shrink-0 flex-col items-center gap-1 pt-2",
      )}
    >
      {TAB_META.map(({ id, icon: Icon, label }) => {
        const isActive = activeTab === id
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={isActive}
            onClick={() => onTabClick(id)}
            className={cn(
              "relative flex items-center justify-center transition-colors",
              isTop
                ? cn(
                    "h-7 flex-1 gap-1.5 rounded-full px-2 text-xs",
                    isActive
                      ? "bg-card font-medium text-foreground shadow-neu-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )
                : cn(
                    "h-8 w-8 rounded-lg",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  ),
            )}
          >
            <Icon className={cn(isTop ? "h-3 w-3" : "h-4 w-4")} />
            {isTop && <span className="truncate">{label}</span>}
            {id === "chat" && chatBadge != null && chatBadge > 0 && (
              <span
                aria-label={`${chatBadge} unread`}
                className={cn(
                  "flex items-center justify-center rounded-full bg-primary text-primary-foreground",
                  isTop
                    ? "ml-0.5 h-4 min-w-4 px-1 text-[9px]"
                    : "absolute -right-0.5 -top-0.5 h-3.5 w-3.5 text-[9px]",
                )}
              >
                {chatBadge > 9 ? "9+" : chatBadge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

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
  const { position: railPosition } = useDockRailPosition()
  const isTopRail = railPosition === "top"

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

  const dockWidth = isOpen ? width : RAIL_WIDTH

  const collapseButton = (
    <button
      type="button"
      title={isOpen ? "Collapse sidebar" : "Expand sidebar"}
      aria-label={isOpen ? "Collapse sidebar" : "Expand sidebar"}
      onClick={() => setActiveTab(isOpen ? null : "files")}
      className={cn(
        "flex items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
        isTopRail && isOpen ? "mx-2 mb-1 mt-auto h-7 w-full" : "mb-2 mt-auto h-7 w-7",
      )}
    >
      {isTopRail && isOpen ? (
        <ChevronUp className="h-3.5 w-3.5" />
      ) : isOpen ? (
        <ChevronLeft className="h-3.5 w-3.5" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5" />
      )}
    </button>
  )

  const resizeHandle = (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        "absolute right-0 top-0 h-full w-1 cursor-col-resize",
        "z-10 transition-colors hover:bg-primary/30 active:bg-primary/50",
      )}
      aria-hidden
      title="Drag to resize"
    />
  )

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 select-none flex-col overflow-hidden"
      style={{ width: dockWidth }}
    >
      <div
        className={cn(
          "relative flex min-h-0 flex-1 overflow-hidden",
          isTopRail && isOpen ? "flex-col" : "flex-row",
        )}
      >
        {isTopRail && isOpen ? (
          // Top-rail expanded: horizontal tab bar + panel below
          <>
            <TabRail
              activeTab={activeTab}
              chatBadge={chatBadge}
              onTabClick={handleRailIconClick}
              orientation="top"
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {activeTab && panels[activeTab]}
            </div>
            {resizeHandle}
            {collapseButton}
          </>
        ) : (
          // Left-rail (always), or top-rail collapsed: vertical 40px icon strip + optional panel
          <>
            <div className="flex h-full w-10 shrink-0 flex-col items-center">
              <TabRail
                activeTab={activeTab}
                chatBadge={chatBadge}
                onTabClick={handleRailIconClick}
                orientation="left"
              />
              {collapseButton}
            </div>
            {isOpen && (
              <>
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  {activeTab && panels[activeTab]}
                </div>
                {resizeHandle}
              </>
            )}
          </>
        )}
      </div>

      <ReportProblemButton />
      <VersionTag />
    </div>
  )
}
