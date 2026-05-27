import type { ReactNode } from "react"

interface Props {
  left?: ReactNode
  right?: ReactNode
}

export function WorkspaceStatusBar({ left, right }: Props) {
  return (
    <div className="neu-flat relative z-10 flex items-center gap-3 px-4 py-1 text-xs">
      <div className="flex items-center gap-2 min-w-0">{left}</div>
      <div className="flex-1" />
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  )
}
