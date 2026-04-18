import type { ReactNode } from "react"

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
