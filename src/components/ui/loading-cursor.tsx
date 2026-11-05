import { createContext, useCallback, useContext, useLayoutEffect, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

type LoadingLabel = {
  label: string
  detail?: ReactNode
  /** A cursor beneath the label registers itself; returns the unregister. */
  register: () => () => void
}

const LoadingLabelContext = createContext<LoadingLabel | null>(null)

const CURSOR_CLASS =
  "inline-block h-[1em] w-[0.5em] translate-y-[0.1em] rounded-[2px] bg-foreground/50 animate-cursor-blink motion-reduce:animate-none motion-reduce:opacity-40"

/**
 * Gives the cursors beneath it a label to print: "Loading project… ▌". A
 * loading boundary (ui/loading-overlay.tsx) provides it so the one cursor
 * inside its template says what is loading, in the place the content will
 * start, instead of a separate pill over the page. A template with no
 * cursor of its own gets a fallback one, placed by `fallbackClassName`.
 */
function LoadingCursorLabel({
  label,
  detail,
  fallbackClassName,
  children,
}: Omit<LoadingLabel, "register"> & { fallbackClassName?: string; children: ReactNode }) {
  const [cursors, setCursors] = useState(0)
  const register = useCallback(() => {
    setCursors((n) => n + 1)
    return () => setCursors((n) => n - 1)
  }, [])
  return (
    <LoadingLabelContext.Provider value={{ label, detail, register }}>
      {children}
      {cursors === 0 ? (
        <span
          data-slot="loading-cursor-fallback"
          className={cn("inline-flex items-center gap-1.5 text-sm text-muted-foreground", fallbackClassName)}
        >
          <span>{label}…{detail}</span>
          <span data-slot="loading-cursor" aria-hidden="true" className={CURSOR_CLASS} />
        </span>
      ) : null}
    </LoadingLabelContext.Provider>
  )
}

/**
 * Blinking terminal-style cursor that marks the one place in a region where
 * content is still being written: the end of the sidebar's nav list, the
 * pending crumb in the breadcrumb, the top of a main body that has not
 * arrived yet. One per region, so the page reads as "printing", not as a
 * field of placeholders. It inherits the font size of its parent, so it sits
 * on the baseline the text will land on. Purely decorative: the container
 * announces the loading state (`role="status"` / `aria-busy`). Inside a
 * LoadingCursorLabel it prints that label ahead of itself.
 */
function LoadingCursor({
  className,
  plain = false,
  ...props
}: React.ComponentProps<"span"> & {
  /** Never print the surrounding label: for a region's secondary cursors. */
  plain?: boolean
}) {
  const context = useContext(LoadingLabelContext)
  const labelled = plain ? null : context
  const register = labelled?.register
  useLayoutEffect(() => register?.(), [register])
  const cursor = (
    <span data-slot="loading-cursor" aria-hidden="true" className={cn(CURSOR_CLASS, className)} {...props} />
  )
  if (!labelled) return cursor
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span>{labelled.label}…{labelled.detail}</span>
      {cursor}
    </span>
  )
}

export { LoadingCursor, LoadingCursorLabel }
