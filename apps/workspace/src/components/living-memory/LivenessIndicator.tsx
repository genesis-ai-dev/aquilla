import { cn } from "@/lib/utils"
import type { LivenessState } from "@/hooks/useLiveness"

interface Props {
  state: LivenessState
  label: string
}

const DOT_CLASSES: Record<LivenessState, string> = {
  live: "bg-green-500",
  updating: "bg-yellow-500 animate-pulse",
  indexing: "bg-blue-500 animate-pulse",
  offline: "bg-muted-foreground",
}

export function LivenessIndicator({ state, label }: Props) {
  return (
    <div className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
      <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASSES[state])} aria-hidden />
      <span>{label}</span>
    </div>
  )
}
