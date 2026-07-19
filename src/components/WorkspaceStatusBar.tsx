import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface Props {
  left?: ReactNode
  right?: ReactNode
  className?: string
}

export function WorkspaceStatusBar({ left, right, className }: Props) {
  return (
    <div className={cn("relative z-10 flex items-center gap-2 px-3 py-1 text-xs", className)}>
      <div className="flex min-w-0 items-center gap-1.5">{left}</div>
      <div className="flex-1" />
      <div className="flex shrink-0 items-center gap-1.5">{right}</div>
    </div>
  )
}
