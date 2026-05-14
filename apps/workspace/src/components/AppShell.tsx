import { useEffect, useState, type ReactNode } from "react"
import { PanelLeftClose, PanelLeftOpen } from "lucide-react"

// Project-wide z-index scale (Tailwind v4 dynamic):
//   z-10 — content stickies (table headers, sticky cells)
//   z-20 — in-content floats (action rails, expansion glyphs)
//   z-30 — app chrome (workspace header, fixed top/bottom banners, status chips)
//   z-40 — popovers, menus, dropdowns, autocomplete
//   z-50 — modals, sheets, dialogs (+ their backdrops)
//   z-60 — toasts / transient notices that must beat everything
// Anything else is a bug. Don't reach for z-[999].

const SIDEBAR_COLLAPSED_KEY = "codex:sidebar-collapsed"

interface Props {
  sidebar: ReactNode
  header: ReactNode
  statusBar: ReactNode
  beforeMain?: ReactNode
  main: ReactNode
  aside?: ReactNode
}

export function AppShell({ sidebar, header, statusBar, beforeMain, main, aside }: Props) {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"
  })

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0")
  }, [collapsed])

  return (
    <div className="flex h-screen min-w-0">
      <aside
        className={`flex shrink-0 flex-col overflow-hidden bg-background transition-[width] duration-200 ease-out ${
          collapsed ? "w-0 border-r-0" : "w-64 border-r"
        }`}
        aria-hidden={collapsed}
      >
        {sidebar}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="relative z-30 flex items-stretch">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex shrink-0 items-center justify-center border-b bg-background px-3 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
          <div className="min-w-0 flex-1">{header}</div>
        </div>
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
