import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

/**
 * Loading boundary for route/chunk and first-data transitions.
 *
 * The optional child is a non-interactive template of the destination. When a
 * route cannot supply one, the neutral shell below avoids a blank screen
 * without guessing at any values. The template is hidden from assistive
 * technology; the wrapper exposes one concise, live loading status.
 */
function LoadingOverlay({
  label = "Loading",
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  label?: string
  children?: ReactNode
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      aria-live="polite"
      className={cn(
        "relative h-full min-h-screen w-full overflow-hidden",
        className,
      )}
      {...props}
    >
      <div
        inert
        aria-hidden="true"
        className="pointer-events-none h-full min-h-screen select-none"
      >
        {children ?? <NeutralLoadingTemplate />}
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/20">
        <div className="flex items-center gap-3 rounded-full border bg-background/90 px-4 py-2 text-sm text-muted-foreground shadow-sm backdrop-blur-sm">
          <Spinner aria-hidden="true" className="size-5" />
          <span>{label}…</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Route-agnostic fallback for lazy chunks. It deliberately contains no labels
 * or values: those belong to the route and must not be invented while its
 * module or data is unresolved.
 */
function NeutralLoadingTemplate() {
  return (
    <div data-testid="loading-neutral-template" className="flex min-h-screen bg-sidebar">
      <aside className="hidden w-56 shrink-0 flex-col gap-5 p-3 sm:flex">
        <div className="flex items-center justify-between">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-8 w-4/5" />
          <Skeleton className="h-8 w-3/5" />
        </div>
        <div className="mt-auto flex flex-col gap-2">
          <Skeleton className="h-8 w-4/5" />
          <Skeleton className="h-10 w-full" />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[52px] shrink-0 items-center px-4">
          <Skeleton className="h-5 w-36" />
        </div>
        <div className="m-2 flex min-h-0 flex-1 flex-col rounded-xl border bg-background">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
            <Skeleton className="h-7 w-48" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-[88px] rounded-2xl" />
              ))}
            </div>
            <div className="grid gap-6 lg:grid-cols-[minmax(14rem,1fr)_minmax(30rem,2fr)]">
              <Skeleton className="h-72 rounded-2xl" />
              <Skeleton className="h-72 rounded-2xl" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export { LoadingOverlay }
