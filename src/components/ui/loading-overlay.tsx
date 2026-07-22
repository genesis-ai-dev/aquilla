import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

/**
 * Centered loading overlay for route/chunk transitions.
 *
 * The standard "something is loading, hang tight" state — established for the
 * lazy workspace route transition (AQU-637) but reusable anywhere a full-area
 * loading indicator is needed. Reuses the shared <Spinner> primitive rather
 * than reinventing spinner styling, and exposes an accessible busy state
 * (`role="status"` + `aria-busy` with a "Loading" label) via the wrapper.
 */
function LoadingOverlay({
  label = "Loading",
  className,
  ...props
}: React.ComponentProps<"div"> & { label?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn(
        "flex h-full min-h-screen w-full flex-col items-center justify-center gap-3",
        className,
      )}
      {...props}
    >
      <Spinner aria-hidden="true" className="size-8 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{label}…</span>
    </div>
  )
}

export { LoadingOverlay }
