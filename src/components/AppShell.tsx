import type { ReactNode } from "react"

// Project-wide z-index scale (Tailwind v4 dynamic):
//   z-10 — content stickies (table headers, sticky cells)
//   z-20 — in-content floats (action rails, expansion glyphs)
//   z-30 — app chrome (workspace header, fixed top/bottom banners, status chips)
//   z-40 — popovers, menus, dropdowns, autocomplete
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
