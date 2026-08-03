import { RefreshCwIcon } from "lucide-react"
import { useUpdateCheck } from "@/hooks/useUpdateCheck"
import { Button } from "@/components/ui/button"

export function UpdateBanner() {
  const updateAvailable = useUpdateCheck()
  if (!updateAvailable) return null

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => window.location.reload()}
      className="fixed bottom-3 left-3 z-30 animate-in slide-in-from-bottom-2 fade-in gap-2 rounded-md border-violet-300 bg-background/90 shadow-md backdrop-blur-sm duration-300 hover:border-violet-400 dark:border-violet-500/50"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
      </span>
      Update available
      <RefreshCwIcon className="h-3.5 w-3.5" />
    </Button>
  )
}
