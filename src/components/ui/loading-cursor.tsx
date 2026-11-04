import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * Blinking terminal-style cursor that marks a place where content is loading.
 *
 * Use it instead of a grey skeleton bar when the surrounding structure is
 * already known: the heading, label or card is real, and only the value or
 * body is pending. The cursor inherits the font size of its parent, so it
 * sits on the same baseline the text will land on. Purely decorative:
 * the container announces the loading state (`role="status"`/`aria-busy`).
 */
function LoadingCursor({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="loading-cursor"
      aria-hidden="true"
      className={cn(
        "inline-block h-[1em] w-[0.5em] translate-y-[0.1em] rounded-[2px] bg-foreground/50",
        "animate-cursor-blink motion-reduce:animate-none motion-reduce:opacity-40",
        className,
      )}
      {...props}
    />
  )
}

/**
 * One text-height line that ends in a blinking cursor. The optional `label`
 * is text that is known already (a heading, a field name); it renders muted
 * ahead of the cursor so the loading state reads as "label: ▌".
 */
function LoadingLine({
  label,
  className,
  cursorClassName,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label?: ReactNode
  cursorClassName?: string
}) {
  return (
    <div
      data-slot="loading-line"
      className={cn("flex min-h-[1.5em] items-center gap-1.5 text-sm leading-normal", className)}
      {...props}
    >
      {label != null && label !== "" ? (
        <span className="truncate text-muted-foreground">{label}</span>
      ) : null}
      <LoadingCursor className={cursorClassName} />
    </div>
  )
}

/** `count` stacked LoadingLines, for a body of text that is not here yet. */
function LoadingLines({
  count = 3,
  className,
  lineClassName,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  count?: number
  lineClassName?: string
}) {
  return (
    <div data-slot="loading-lines" className={cn("flex flex-col gap-1", className)} {...props}>
      {Array.from({ length: count }).map((_, i) => (
        <LoadingLine key={i} className={lineClassName} />
      ))}
    </div>
  )
}

export { LoadingCursor, LoadingLine, LoadingLines }
