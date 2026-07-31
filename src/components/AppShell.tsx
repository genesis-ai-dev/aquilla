import { useContext, useEffect, useState, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { usePanelRef } from "react-resizable-panels"
import { cn } from "@/lib/utils"
import { BrandContext } from "@/branding/use-brand"
import { VersionTag } from "./VersionBadge"
import { BetaBadge } from "./BetaBadge"
import { NavHistoryControls } from "./NavHistoryControls"
import { ErrorBoundary } from "./ErrorBoundary"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"

// Project-wide z-index scale (Tailwind v4 dynamic):
//   (no z) — in-flow chrome (workspace header, status bar, sidebar). It sits
//            above main content physically via flex layout — adding z-index
//            would trap dropdowns inside the chrome's stacking context and
//            cause portal'd menus/tooltips to paint BEHIND the chrome.
//   z-10 — content stickies (table headers, sticky cells)
//   z-20 — in-content floats (action rails, expansion glyphs)
//   z-30 — fixed bottom action chips/bars (SelectionBar, AiModelDownloadChip,
//          AudioBulkProgressBanner) that float over the editor
//   z-40 — fixed overlay banners (PrivateMode, SyncFreeze), popovers, menus,
//          dropdowns, tooltips, autocomplete
//   z-50 — modals, sheets, dialogs (+ their backdrops)
//   z-60 — toasts / transient notices that must beat everything
// Anything else is a bug. Don't reach for z-[999].

const DOCK_MIN_WIDTH = 200
const DOCK_MAX_WIDTH = 520
const DOCK_DEFAULT_WIDTH = 256
/** Collapsed rail (40) + aside `pl-2` inset (8) when railCollapsed. */
const DOCK_COLLAPSED_WIDTH = 48

const VIDEO_STORAGE_KEY = "codex:video-height"
const VIDEO_DEFAULT_HEIGHT = 320
const VIDEO_MIN_HEIGHT = 120

function readStoredDockWidth(storageKey: string | undefined): number {
  if (!storageKey) return DOCK_DEFAULT_WIDTH
  try {
    const saved = localStorage.getItem(`left-dock-width:${storageKey}`)
    if (saved) {
      const n = parseInt(saved, 10)
      if (n >= DOCK_MIN_WIDTH && n <= DOCK_MAX_WIDTH) return n
    }
  } catch {
    // ignore
  }
  return DOCK_DEFAULT_WIDTH
}

function writeStoredDockWidth(storageKey: string | undefined, width: number) {
  if (!storageKey) return
  try {
    localStorage.setItem(`left-dock-width:${storageKey}`, String(Math.round(width)))
  } catch {
    // ignore
  }
}

function readStoredVideoHeight(): number {
  try {
    const stored = localStorage.getItem(VIDEO_STORAGE_KEY)
    if (stored) {
      const n = parseInt(stored, 10)
      if (n >= VIDEO_MIN_HEIGHT) return n
    }
  } catch {
    // ignore
  }
  return VIDEO_DEFAULT_HEIGHT
}

function writeStoredVideoHeight(height: number) {
  try {
    localStorage.setItem(VIDEO_STORAGE_KEY, String(Math.round(height)))
  } catch {
    // ignore
  }
}

interface Props {
  /** AQU-308: The left dock (collapsible, resizable, multi-tab panel).
   * Replaces the old fixed-width `sidebar` prop. Width is owned by the
   * shadcn ResizablePanelGroup in this shell. */
  leftDock?: ReactNode
  /** Persist dock width per project (`left-dock-width:${key}`). */
  dockStorageKey?: string
  /** @deprecated Use `leftDock` for ProjectWorkspace. Other pages still use
   * this for OrgSidebar until they migrate. */
  sidebar?: ReactNode
  header: ReactNode
  statusBar: ReactNode
  /** Rendered on the chrome frame directly above the main content card
   *  (e.g. file tabs). Stays outside the card border/background. */
  aboveCard?: ReactNode
  beforeMain?: ReactNode
  /**
   * Optional top pane inside the content card (e.g. subtitle video), resized
   * vertically against `main` via shadcn Resizable.
   */
  resizableTop?: ReactNode
  main: ReactNode
  aside?: ReactNode
  /** Brand logo mark rendered at the top of the dock rail — passed here so
   * AppShell can stay the single source for the logo placement. */
  logoSlot?: ReactNode
  /** Rendered to the right of the logo (e.g. the workspace's collapse-sidebar
   * toggle) so rail controls live in the logo row, not the dock footer. */
  logoAccessory?: ReactNode
  /** When the left dock is collapsed to its icon rail, stack the top chrome
   * (logo, nav history, beta badge) vertically so the rail can stay narrow
   * instead of being stretched by the horizontal logo row. */
  railCollapsed?: boolean
}

export function AppShell({
  leftDock,
  dockStorageKey,
  sidebar,
  logoSlot,
  logoAccessory,
  header,
  statusBar,
  aboveCard,
  beforeMain,
  resizableTop,
  main,
  aside,
  railCollapsed,
}: Props) {
  const dockContent = leftDock ?? sidebar
  const useDockResize = Boolean(leftDock)
  // Route-keyed so a crash in one page's content doesn't stick around after
  // the user navigates elsewhere — a key change unmounts + remounts the
  // boundary, clearing its error state. Chrome (sidebar, header, status bar)
  // stays outside the boundary so navigation itself is never blocked by a
  // crash in the main content.
  const { pathname } = useLocation()
  // Optional read (not useBrand) — the shell is rendered by page tests that
  // don't mount BrandProvider; the logo link is chrome, not a hard dependency.
  const brand = useContext(BrandContext)
  const resolvedLogo = logoSlot ?? (brand ? (
    <a
      href="/homepage"
      aria-label={`${brand.app.name} — homepage`}
      className="flex w-fit cursor-default items-center rounded-md p-1.5 hover:bg-accent/60"
    >
      <brand.logo.Mark className="h-6 w-6 shrink-0" aria-hidden />
    </a>
  ) : null)

  const dockPanelRef = usePanelRef()
  const [dockWidth] = useState(() => readStoredDockWidth(dockStorageKey))
  const [videoHeight] = useState(() => readStoredVideoHeight())

  // Keep the resizable dock panel in sync with tab collapse/expand.
  useEffect(() => {
    if (!useDockResize) return
    const panel = dockPanelRef.current
    if (!panel) return
    if (railCollapsed) {
      panel.resize(DOCK_COLLAPSED_WIDTH)
    } else {
      panel.resize(readStoredDockWidth(dockStorageKey))
    }
  }, [railCollapsed, useDockResize, dockStorageKey, dockPanelRef])

  // Status / playback sit at the bottom of the MAIN column (not under `aside`)
  // so the transport/volume share the editor's right edge when drawers/sidebars
  // are open — instead of stretching under them and looking "escaped."
  const mainStack = (
    <main className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <ErrorBoundary key={pathname} compact>
            {main}
          </ErrorBoundary>
        </div>
        {statusBar ? <div className="shrink-0">{statusBar}</div> : null}
      </div>
      {aside}
    </main>
  )

  const cardBody = resizableTop ? (
    <>
      {beforeMain}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel
          id="shell-top"
          defaultSize={videoHeight}
          minSize={VIDEO_MIN_HEIGHT}
          maxSize="70%"
          groupResizeBehavior="preserve-pixel-size"
          onResize={(size) => {
            if (size.inPixels >= VIDEO_MIN_HEIGHT) writeStoredVideoHeight(size.inPixels)
          }}
        >
          <div className="h-full min-h-0 overflow-hidden">{resizableTop}</div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="shell-main" minSize="30%">
          {mainStack}
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  ) : (
    <>
      {beforeMain}
      {mainStack}
    </>
  )

  const asideEl = (
    <aside
      className={cn(
        "relative z-10 flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden",
        // Org pages use a fixed-width sidebar; project workspace width is
        // owned by the Resizable panel below.
        !leftDock && "w-56",
        // Collapsed rail: mirror the floating main card's 8px left inset (m-2
        // below) so the centered icon column reads as centered in the visible
        // chrome band instead of being pulled toward the screen edge.
        railCollapsed && "pl-2",
      )}
    >
      {(resolvedLogo || logoAccessory) && (
        <div
          className={cn(
            // Vertical/horizontal spacing is owned here so every child aligns by
            // box-center under items-center — no per-child mt-2 to drift the row.
            "flex shrink-0 pt-2",
            railCollapsed ? "flex-col items-center gap-1" : "items-center justify-between px-2",
          )}
        >
          <div className={cn("flex gap-0.5", railCollapsed ? "flex-col items-center" : "items-center")}>
            {resolvedLogo}
            {/* Browser-style back/forward + history popover, top-left chrome. */}
            <NavHistoryControls />
          </div>
          {/* BETA + collapse toggle ride together as a right-aligned cluster so the
              badge hugs the toggle instead of floating in the justify-between middle
              slot. On org pages / collapsed rail there's no toggle, so it's just the badge. */}
          <div className="flex items-center gap-2">
            <BetaBadge />
            {logoAccessory && <div className="shrink-0">{logoAccessory}</div>}
          </div>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{dockContent}</div>
      {!leftDock && (
        <div className="flex shrink-0 items-center">
          <div className="min-w-0 flex-1">
            <VersionTag />
          </div>
        </div>
      )}
    </aside>
  )

  const workspaceColumn = (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* Every route gets the same fixed header band. File tabs are a
          separate row below it and must not move the breadcrumb baseline. */}
      <div data-slot="app-shell-header" className="flex h-[52px] min-h-[52px] shrink-0 flex-col justify-center">
        {header}
      </div>
      {aboveCard ? (
        <div className="mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-w-0 shrink-0 pb-1">{aboveCard}</div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
            {cardBody}
          </div>
        </div>
      ) : (
        <div className="m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
          {cardBody}
        </div>
      )}
    </div>
  )

  // Linear "frame + floating card" model: the sidebar and header share the
  // chrome base (bg-sidebar); the main workspace is a distinct, lighter card
  // inset on every side and fully rounded. Status / playback sit inside the
  // card's main column (alongside any right aside) so they stay aligned with
  // the editor shell on both edges.
  return (
    <div className="flex h-screen min-w-0 bg-sidebar">
      {useDockResize ? (
        <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
          <ResizablePanel
            id="shell-dock"
            panelRef={dockPanelRef}
            defaultSize={railCollapsed ? DOCK_COLLAPSED_WIDTH : dockWidth}
            minSize={railCollapsed ? DOCK_COLLAPSED_WIDTH : DOCK_MIN_WIDTH}
            maxSize={railCollapsed ? DOCK_COLLAPSED_WIDTH : DOCK_MAX_WIDTH}
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size) => {
              if (!railCollapsed && size.inPixels >= DOCK_MIN_WIDTH) {
                writeStoredDockWidth(dockStorageKey, size.inPixels)
              }
            }}
          >
            {asideEl}
          </ResizablePanel>
          <ResizableHandle disabled={Boolean(railCollapsed)} />
          <ResizablePanel id="shell-workspace" minSize="40%">
            {workspaceColumn}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <>
          {asideEl}
          {workspaceColumn}
        </>
      )}
    </div>
  )
}
