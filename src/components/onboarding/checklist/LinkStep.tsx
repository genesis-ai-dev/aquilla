import { ArrowRight, Circle } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * An optional setup step that is not tracked for completion: it just sends the
 * user to the surface where the work happens (Living Memory standards, the
 * terminology view).
 */
export function LinkStep({
  title,
  description,
  actionLabel,
  onOpen,
}: {
  title: string
  description: string
  actionLabel: string
  onOpen: () => void
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Circle
        className="mt-0.5 size-4 shrink-0 text-muted-foreground/40"
        aria-hidden
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-1">
          <span className="text-sm font-medium">{title}</span>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onOpen}>
          {actionLabel}
          <ArrowRight aria-hidden />
        </Button>
      </div>
    </div>
  )
}
