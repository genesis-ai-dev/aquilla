import type { ReactNode } from "react"

interface Props {
  left?: ReactNode
  right?: ReactNode
}

export function WorkspaceStatusBar({ left, right }: Props) {
  return (
    <div className="flex items-center gap-3 border-t bg-muted/30 px-4 py-1 text-xs">
      <div className="flex items-center gap-2 min-w-0">{left}</div>
      <div className="flex-1" />
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  )
}
