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
    <div className="flex h-screen">
      <aside className="flex w-56 flex-col border-r bg-background">
        {sidebar}
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        {header}
        {beforeMain}
        <main className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden">{main}</div>
          {aside}
        </main>
        {statusBar}
      </div>
    </div>
  )
}
