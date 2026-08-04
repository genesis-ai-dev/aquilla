import type { ReactNode } from "react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

/** The shared spinner pill shown centered on every loading overlay. */
function LoadingStatusPill({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-background/90 px-4 py-2 text-sm text-muted-foreground shadow-sm backdrop-blur-sm">
      <Spinner aria-hidden="true" className="size-5" />
      <span>{label}…</span>
    </div>
  )
}

type LoadingTemplateProps = Omit<React.ComponentProps<"div">, "children"> & {
  label?: string
  children: ReactNode
  templateClassName?: string
}

/**
 * Container-safe loading boundary for first-data transitions.
 *
 * The child is a non-interactive template of the destination. It remains
 * visible to preserve geometry, while assistive technology receives one
 * concise live status instead of every decorative skeleton block.
 */
function LoadingTemplate({
  label = "Loading",
  children,
  className,
  templateClassName,
  ...props
}: LoadingTemplateProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      aria-live="polite"
      className={cn("relative w-full overflow-hidden", className)}
      {...props}
    >
      <div
        inert
        aria-hidden="true"
        className={cn(
          "pointer-events-none h-full select-none",
          templateClassName,
        )}
      >
        {children}
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/20">
        <LoadingStatusPill label={label} />
      </div>
    </div>
  )
}

/**
 * Viewport-blocking overlay for in-flight route transitions (AQU-737).
 *
 * Unlike LoadingTemplate — whose scrim is pointer-transparent because the
 * template beneath it is already inert — this overlay portals to <body> and
 * swallows pointer input for the whole display area, so no other control can
 * be activated while the destination chunk/data loads. Render it only while
 * the transition is actually pending; it carries no timer of its own.
 */
function BlockingLoadingOverlay({
  label = "Loading",
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label?: string
}) {
  return createPortal(
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      aria-live="polite"
      className={cn(
        "fixed inset-0 z-50 flex cursor-wait items-center justify-center bg-background/20",
        className,
      )}
      {...props}
    >
      <LoadingStatusPill label={label} />
    </div>,
    document.body,
  )
}

/**
 * Full-screen loading boundary for route/chunk transitions.
 *
 * When a route cannot supply a destination template, the neutral shell avoids
 * a blank screen without guessing at labels or values.
 */
function LoadingOverlay({
  label = "Loading",
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label?: string
  children?: ReactNode
}) {
  return (
    <LoadingTemplate
      label={label}
      className={cn("h-full min-h-screen", className)}
      templateClassName="min-h-screen"
      {...props}
    >
      {children ?? <NeutralLoadingTemplate />}
    </LoadingTemplate>
  )
}

/**
 * Neutral major-panel fallback for lazily loaded workspace surfaces. It
 * communicates shape and activity without fabricating route-specific data.
 */
function LoadingPanel({
  label = "Loading",
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label?: string
}) {
  return (
    <LoadingTemplate
      label={label}
      className={cn("h-full min-h-64", className)}
      templateClassName="min-h-64"
      {...props}
    >
      <div
        data-testid="loading-panel-template"
        className="flex min-h-64 flex-col gap-5 p-6"
      >
        <Skeleton className="h-6 w-44" />
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-20 rounded-xl" />
          ))}
        </div>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-12 rounded-xl" />
          ))}
        </div>
      </div>
    </LoadingTemplate>
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
          <Skeleton className="h-5 w-12 rounded-lg" />
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

export { BlockingLoadingOverlay, LoadingOverlay, LoadingPanel, LoadingTemplate }
