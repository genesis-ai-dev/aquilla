import { useContext, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { cn } from "@/lib/utils"
import { BrandContext } from "@/branding/use-brand"
import { VersionTag } from "./VersionBadge"
import { BetaBadge } from "./BetaBadge"
import { NavHistoryControls } from "./NavHistoryControls"
import { ErrorBoundary } from "./ErrorBoundary"

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

interface Props {
  /** AQU-308: The left dock (collapsible, resizable, multi-tab panel).
   * Replaces the old fixed-width `sidebar` prop. The dock owns its own
   * width and collapse state so AppShell stays layout-only. */
  leftDock?: ReactNode
  /** @deprecated Use `leftDock` for ProjectWorkspace. Other pages still use
   * this for OrgSidebar until they migrate. */
  sidebar?: ReactNode
  header: ReactNode
  statusBar: ReactNode
  /** Rendered on the chrome frame directly above the main content card
   *  (e.g. file tabs). Stays outside the card border/background. */
  aboveCard?: ReactNode
  beforeMain?: ReactNode
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

export function AppShell({ leftDock, sidebar, logoSlot, logoAccessory, header, statusBar, aboveCard, beforeMain, main, aside, railCollapsed }: Props) {
  const dockContent = leftDock ?? sidebar
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
      className="flex w-fit items-center rounded-md p-1.5 hover:bg-accent/60"
    >
      <brand.logo.Mark className="h-6 w-6 shrink-0" aria-hidden />
    </a>
  ) : null)
  // Status / playback sit at the bottom of the MAIN column (not under `aside`)
  // so the transport/volume share the editor's right edge when drawers/sidebars
  // are open — instead of stretching under them and looking "escaped."
  const cardBody = (
    <>
      {beforeMain}
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
    </>
  )

  return (
    // Linear "frame + floating card" model: the sidebar and header share the
    // chrome base (bg-sidebar); the main workspace is a distinct, lighter card
    // inset on every side and fully rounded. Status / playback sit inside the
    // card's main column (alongside any right aside) so they stay aligned with
    // the editor shell on both edges.
    <div className="flex h-screen min-w-0 bg-sidebar">
      {/* AQU-308: Left dock — width is controlled by LeftDock itself (resizable + collapsible).
          The aside wrapper is kept so the logo can live above the dock rail. */}
      <aside
        className={cn(
          "relative z-10 flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden",
          // Org pages use a fixed-width sidebar; project workspace width is
          // owned by LeftDock (resizable). Footer chrome for the dock lives
          // inside LeftDock so a long branch name can't stretch the rail.
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
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Every route gets the same fixed header band. File tabs are a
            separate row below it and must not move the breadcrumb baseline. */}
        <div data-slot="app-shell-header" className="flex h-[52px] min-h-[52px] shrink-0 flex-col justify-center">
          {header}
        </div>
        {aboveCard ? (
          <div className="mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 pb-1">{aboveCard}</div>
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
    </div>
  )
}
