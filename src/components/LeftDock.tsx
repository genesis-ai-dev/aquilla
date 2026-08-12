/**
 * LeftDock.tsx — AQU-308 + AQU-320
 *
 * Collapsible left dock that replaces the fixed-width sidebar.
 * Hosts multiple surfaces as icon-tab switchers (like Claude's sidebar):
 *   - files   : project file list (was the old sidebar content)
 *   - search  : search / parallel passages / find-replace panel
 *
 * Collapsed: renders a narrow rail of icon buttons only (no labels).
 * Expanded: shows the full panel. Width is owned by AppShell's shadcn
 * ResizablePanelGroup (drag handle lives there).
 *
 * Tab rail position (left vs top) is a user preference — see Preferences.
 */

import {
  useState,
  useCallback,
  type ReactNode,
} from "react"
import {
  Files,
  Search,
  AudioLines,
  PanelLeftOpen,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { HelpMenu } from "@/components/HelpMenu"
import { VersionTag } from "@/components/VersionBadge"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { useDockRailPosition } from "@/hooks/useDockRailPosition"
import { AppTooltip } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DockTab = "files" | "search" | "voices"

export interface LeftDockProps {
  /** Slot rendered when "files" tab is active */
  filesPanel: ReactNode
  /** Slot rendered when "search" tab is active */
  searchPanel: ReactNode
  /** Slot rendered when "voices" tab is active. When omitted, the Voices tab
   *  is hidden (e.g. a project without the Audio lens available). */
  voicesPanel?: ReactNode
  /** Default tab to show when dock opens */
  defaultTab?: DockTab
  /** Externally controlled active tab (useful for "open chat" button in header) */
  activeTab?: DockTab | null
  onActiveTabChange?: (tab: DockTab | null) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type TabMeta = { id: DockTab; icon: typeof Files; labelKey: Parameters<ReturnType<typeof useT>>[0] }

const TAB_META: TabMeta[] = [
  { id: "files", icon: Files, labelKey: "nav.dock.filesTab" },
  { id: "voices", icon: AudioLines, labelKey: "common.voices" },
  { id: "search", icon: Search, labelKey: "nav.search" },
]

// ---------------------------------------------------------------------------
// Tab rail
// ---------------------------------------------------------------------------

interface TabRailProps {
  tabs: TabMeta[]
  activeTab: DockTab | null
  onTabClick: (tab: DockTab) => void
  orientation: "left" | "top"
}

function TabRail({ tabs, activeTab, onTabClick, orientation }: TabRailProps) {
  const t = useT()
  const isTop = orientation === "top"

  return (
    <div
      className={cn(
        isTop
          ? "mx-2 mt-2 flex min-w-0 items-center gap-0.5 rounded-md p-1 bg-muted"
          : "flex h-full w-10 shrink-0 flex-col items-center gap-1 pt-2",
      )}
    >
      {tabs.map(({ id, icon: Icon, labelKey }) => {
        const label = t(labelKey)
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
  searchPanel,
  voicesPanel,
  activeTab: controlledTab,
  onActiveTabChange,
}: LeftDockProps) {
  const t = useT()
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
    search: searchPanel,
    voices: voicesPanel,
  }
  // Only surface tabs whose panel slot is provided (Voices is conditional).
  const visibleTabs = TAB_META.filter((t) => panels[t.id] != null)

  // Collapse (when open) lives next to the logo at the top of the rail — see
  // AppShell's logoAccessory slot. The dock only renders the EXPAND affordance
  // on the collapsed 40px icon strip.
  const expandButton = (
    <AppTooltip content={t("nav.dock.expandSidebar")} side="right">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("nav.dock.expandSidebar")}
        onClick={() => setActiveTab("files")}
        className="mt-3"
      >
        <PanelLeftOpen className="h-3.5 w-3.5" />
      </Button>
    </AppTooltip>
  )

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-1 select-none flex-col overflow-hidden">
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
              onTabClick={handleRailIconClick}
              orientation="top"
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {activeTab && panels[activeTab]}
            </div>
          </>
        ) : (
          // Left-rail (always), or top-rail collapsed: vertical 40px icon strip + optional panel
          <>
            <div className="flex h-full w-10 shrink-0 flex-col items-center">
              {!isOpen && expandButton}
              <TabRail
                tabs={visibleTabs}
                activeTab={activeTab}
                onTabClick={handleRailIconClick}
                orientation="left"
              />
            </div>
            {isOpen && (
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {activeTab && panels[activeTab]}
              </div>
            )}
          </>
        )}
      </div>

      {/* Help + account live at the dock root so they're present in every tab
          and even when collapsed (compact icon / avatar on the 40px rail). */}
      <div
        className={cn(
          "shrink-0 border-t pt-2",
          isOpen ? "flex flex-col gap-1 px-2 pb-1" : "flex flex-col items-center gap-1 pb-1",
        )}
      >
        <HelpMenu compact={!isOpen} showTour={false} />
        <div data-tour="account-switcher">
          <AccountSwitcher variant="sidebar" compact={!isOpen} />
        </div>
      </div>

      <div className="flex shrink-0 items-center">
        <div className="min-w-0 flex-1">
          <VersionTag />
        </div>
      </div>
    </div>
  )
}
