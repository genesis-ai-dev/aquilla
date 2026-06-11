import { useContext, type ReactNode } from "react"
import { BrandContext } from "@/branding/use-brand"
import { VersionTag } from "./VersionBadge"

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
  /** FRO-308: The left dock (collapsible, resizable, multi-tab panel).
   * Replaces the old fixed-width `sidebar` prop. The dock owns its own
   * width and collapse state so AppShell stays layout-only. */
  leftDock?: ReactNode
  /** @deprecated Use `leftDock` for ProjectWorkspace. Other pages still use
   * this for OrgSidebar until they migrate. */
  sidebar?: ReactNode
  header: ReactNode
  statusBar: ReactNode
  beforeMain?: ReactNode
  main: ReactNode
  aside?: ReactNode
  /** Brand logo mark rendered at the top of the dock rail — passed here so
   * AppShell can stay the single source for the logo placement. */
  logoSlot?: ReactNode
}

export function AppShell({ leftDock, sidebar, logoSlot, header, statusBar, beforeMain, main, aside }: Props) {
  const dockContent = leftDock ?? sidebar
  // Optional read (not useBrand) — the shell is rendered by page tests that
  // don't mount BrandProvider; the logo link is chrome, not a hard dependency.
  const brand = useContext(BrandContext)
  const resolvedLogo = logoSlot ?? (brand ? (
    <a
      href="/homepage"
      aria-label={`${brand.app.name} — homepage`}
      className="mx-2 mt-2 flex w-fit items-center rounded-md p-1.5 hover:bg-accent/60"
    >
      <brand.logo.Mark className="h-6 w-6 shrink-0" aria-hidden />
    </a>
  ) : null)
  return (
    // Linear "frame + floating card" model: the sidebar, header, and status
    // bar all share the chrome base (bg-sidebar) as one continuous, lower/darker
    // layer; the main workspace is a distinct, lighter card that sits ON TOP of
    // it — inset on every side (top, sides, bottom) and fully rounded so the
    // chrome reads as a frame wrapping the whole editor.
    <div className="flex h-screen min-w-0 bg-sidebar">
      {/* FRO-308: Left dock — width is controlled by LeftDock itself (resizable + collapsible).
          The aside wrapper is kept so the logo can live above the dock rail. */}
      <aside className="relative z-10 flex shrink-0 flex-col overflow-hidden">
        {resolvedLogo}
        {dockContent}
        <VersionTag />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {header}
        <div className="m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
          {beforeMain}
          <main className="flex min-h-0 flex-1 overflow-hidden">
            <div className="min-w-0 flex-1 overflow-hidden">{main}</div>
            {aside}
          </main>
        </div>
        {statusBar}
      </div>
    </div>
  )
}
