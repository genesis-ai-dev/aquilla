import type { ReactNode } from "react"
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
  sidebar: ReactNode
  header: ReactNode
  statusBar: ReactNode
  beforeMain?: ReactNode
  main: ReactNode
  aside?: ReactNode
}

export function AppShell({ sidebar, header, statusBar, beforeMain, main, aside }: Props) {
  return (
    // Linear "frame + floating panel" model: the sidebar, header, and status
    // bar all share the chrome base (bg-sidebar) as one continuous layer; the
    // main workspace is a distinct, lighter surface that sits ON TOP of it,
    // tucked into the frame's inner corner with a rounded top-left edge.
    <div className="flex h-screen min-w-0 bg-sidebar">
      <aside className="relative z-10 flex w-64 shrink-0 flex-col overflow-hidden">
        {sidebar}
        <VersionTag />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {header}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-l border-t border-border bg-background">
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
