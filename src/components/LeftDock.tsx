/**
 * LeftDock.tsx — AQU-308 + AQU-320
 *
 * Collapsible, resizable left dock that replaces the fixed-width sidebar.
 * Hosts multiple surfaces as icon-tab switchers (like Claude's sidebar):
 *   - files   : project file list (was the old sidebar content)
 *   - agent   : AI agent (was a right-side Sheet drawer — AQU-320)
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
  Bot,
  Search,
  AudioLines,
  PanelLeftOpen,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ReportProblemButton } from "@/components/ReportProblemButton/ReportProblemButton"
import { VersionTag } from "@/components/VersionBadge"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { useDockRailPosition } from "@/hooks/useDockRailPosition"
import { AppTooltip } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DockTab = "files" | "agent" | "search" | "voices"

export interface LeftDockProps {
  /** Slot rendered when "files" tab is active */
  filesPanel: ReactNode
  /** Slot rendered when "agent" tab is active */
  agentPanel: ReactNode
  /** Slot rendered when "search" tab is active */
  searchPanel: ReactNode
  /** Slot rendered when "voices" tab is active. When omitted, the Voices tab
   *  is hidden (e.g. a project without the Audio lens available). */
  voicesPanel?: ReactNode
  /** Persist width / open-state per project */
  storageKey?: string
  /** Badge on the agent tab (e.g. unread) */
  agentBadge?: number
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

type TabMeta = { id: DockTab; icon: typeof Files; label: string }

const TAB_META: TabMeta[] = [
  { id: "files", icon: Files, label: "Files" },
  { id: "voices", icon: AudioLines, label: "Voices" },
  { id: "agent", icon: Bot, label: "Agent" },
  { id: "search", icon: Search, label: "Search" },
]

// ---------------------------------------------------------------------------
// Tab rail
// ---------------------------------------------------------------------------

interface TabRailProps {
  tabs: TabMeta[]
  activeTab: DockTab | null
  agentBadge?: number
  onTabClick: (tab: DockTab) => void
  orientation: "left" | "top"
}

function TabRail({ tabs, activeTab, agentBadge, onTabClick, orientation }: TabRailProps) {
  const isTop = orientation === "top"

  return (
    <div
      className={cn(
        isTop
          ? "mx-2 mt-2 flex min-w-0 items-center gap-0.5 rounded-md p-1 bg-muted"
          : "flex h-full w-10 shrink-0 flex-col items-center gap-1 pt-2",
      )}
    >
      {tabs.map(({ id, icon: Icon, label }) => {
        const isActive = activeTab === id
        const button = (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-pressed={isActive}
            onClick={() => onTabClick(id)}
            className={cn(
              "relative flex items-center justify-center transition-colors",
              isTop
                ? cn(
                    "h-7 gap-1.5 rounded-md px-2 text-xs",
                    // Only the active tab shows its label (and flexes to fill);
                    // the rest collapse to icon-only so 4+ tabs never overflow.
                    isActive
                      ? "min-w-0 flex-1 bg-card font-medium text-foreground"
                      : "shrink-0 text-muted-foreground hover:text-foreground",
                  )
                : cn(
                    "h-8 w-8 rounded-lg",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  ),
            )}
          >
            <Icon className={cn("shrink-0", isTop ? "h-3 w-3" : "h-4 w-4")} />
            {isTop && isActive && <span className="truncate">{label}</span>}
            {id === "agent" && agentBadge != null && agentBadge > 0 && (
              <span
                aria-label={`${agentBadge} unread`}
                className={cn(
                  "flex items-center justify-center rounded-md bg-primary text-primary-foreground",
                  isTop
                    ? "ml-0.5 h-4 min-w-4 px-1 text-[9px]"
                    : "absolute -right-0.5 -top-0.5 h-3.5 w-3.5 text-[9px]",
                )}
              >
                {agentBadge > 9 ? "9+" : agentBadge}
              </span>
            )}
          </button>
        )
        return isTop ? (
          button
        ) : (
          <AppTooltip key={id} content={label} side="right">
            {button}
          </AppTooltip>
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
  agentPanel,
  searchPanel,
  voicesPanel,
  storageKey,
  agentBadge,
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
    agent: agentPanel,
    search: searchPanel,
    voices: voicesPanel,
  }
  // Only surface tabs whose panel slot is provided (Voices is conditional).
  const visibleTabs = TAB_META.filter((t) => panels[t.id] != null)

  const dockWidth = isOpen ? width : RAIL_WIDTH

  // Collapse (when open) lives next to the logo at the top of the rail — see
  // AppShell's logoAccessory slot. The dock only renders the EXPAND affordance
  // on the collapsed 40px icon strip.
  const expandButton = (
    <AppTooltip content="Expand sidebar" side="right">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Expand sidebar"
        onClick={() => setActiveTab("files")}
        className="mt-3"
      >
        <PanelLeftOpen className="h-3.5 w-3.5" />
      </Button>
    </AppTooltip>
  )

  const resizeHandle = (
    <AppTooltip content="Drag to resize" side="right">
      <div
        onMouseDown={handleDragStart}
        className={cn(
          "absolute right-0 top-0 h-full w-1 cursor-col-resize",
          "z-10 transition-colors hover:bg-primary/30 active:bg-primary/50",
        )}
        aria-hidden
      />
    </AppTooltip>
  )

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 select-none flex-col overflow-hidden m-auto"
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
              tabs={visibleTabs}
              activeTab={activeTab}
              agentBadge={agentBadge}
              onTabClick={handleRailIconClick}
              orientation="top"
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {activeTab && panels[activeTab]}
            </div>
            {resizeHandle}
          </>
        ) : (
          // Left-rail (always), or top-rail collapsed: vertical 40px icon strip + optional panel
          <>
            <div className="flex h-full w-10 shrink-0 flex-col items-center">
              {!isOpen && expandButton}
              <TabRail
                tabs={visibleTabs}
                activeTab={activeTab}
                agentBadge={agentBadge}
                onTabClick={handleRailIconClick}
                orientation="left"
              />
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

      {/* Account picker lives at the dock root so it's present in every tab
          and even when collapsed (compact avatar on the 40px rail). */}
      <div
        className={cn(
          "shrink-0 border-t pt-2",
          isOpen ? "px-2 pb-1" : "flex flex-col items-center pb-1",
        )}
        data-tour="account-switcher"
      >
        <AccountSwitcher variant="sidebar" compact={!isOpen} />
      </div>

      <div className="flex shrink-0 items-center">
        <div className="min-w-0 flex-1">
          <VersionTag />
        </div>
        <ReportProblemButton />
      </div>
    </div>
  )
}
