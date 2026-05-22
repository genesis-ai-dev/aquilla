import type { ReactNode } from "react"

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
    <div className="flex h-screen min-w-0">
      <aside className="flex w-64 shrink-0 flex-col overflow-hidden border-r bg-background">
        {sidebar}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {header}
        {beforeMain}
        <main className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">{main}</div>
          {aside}
        </main>
        {statusBar}
      </div>
    </div>
  )
}
