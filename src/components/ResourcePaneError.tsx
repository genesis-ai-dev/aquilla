// AQU-849: the inline failure state shared by the editor's resource side panels
// (Parallel Bibles, Verse Resources).
//
// A reference lookup failing is expected — the upstreams are free, keyless and
// occasionally rate-limited. What is not acceptable is the panel going dead
// until the translator reloads the page, which is what a partner hit mid-demo
// on 2026-08-10. So every failure inside a pane renders here: the reason stays
// in the pane, the rest of the editor keeps working, and Retry re-runs the
// lookup in place.

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"

interface ResourcePaneErrorProps {
  /** Human-readable reason, already localised by the caller. */
  message: string
  onRetry: () => void
  /** Screen-reader name for the retry button when several share a pane. */
  retryLabel?: string
  className?: string
}

export function ResourcePaneError({
  message,
  onRetry,
  retryLabel,
  className,
}: ResourcePaneErrorProps) {
  const t = useT()
  return (
    <div className={cn("space-y-1.5", className)}>
      <p className="text-xs text-destructive">{message}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRetry}
        aria-label={retryLabel}
        className="h-6 px-2 text-xs"
      >
        {t("common.retry")}
      </Button>
    </div>
  )
}

/** Fallback for a render throw caught by a pane-level `ErrorBoundary`.
 *  `onRetry` is the boundary's reset, so the pane remounts in place. */
export function ResourcePaneCrash({
  onRetry,
  className,
}: {
  onRetry: () => void
  className?: string
}) {
  const t = useT()
  return (
    <ResourcePaneError
      message={t("editor.resourcePane.crashed")}
      onRetry={onRetry}
      className={cn("border-l bg-card p-4 text-sm", className)}
    />
  )
}
