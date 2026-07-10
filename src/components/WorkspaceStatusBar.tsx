import type { ReactNode } from "react"

interface Props {
  left?: ReactNode
  right?: ReactNode
}

export function WorkspaceStatusBar({ left, right }: Props) {
  return (
    <div className="relative z-10 flex items-center gap-2 px-3 py-1 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">{left}</div>
      <div className="flex-1" />
      <div className="flex shrink-0 items-center gap-1.5">{right}</div>
    </div>
  )
}
