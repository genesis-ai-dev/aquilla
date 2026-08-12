import { useLayoutEffect, useRef, useState } from "react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// AQU-491: hover-only affordances aren't discoverable ("At first, I was trying
// to find a way to expand the episode name... After a while, I realized that
// hovering over it displays the full name." — Anna). This wraps a truncated
// name in a click-to-reveal Popover *only when the text actually overflows*
// its box (measured via scrollWidth vs clientWidth, re-checked on resize), so
// short names stay plain and untruncated ones never grow a false "expandable"
// cue. The trigger keeps the same DOM shape (button > span) whether or not
// it's truncated, so toggling `truncated` never remounts the measured node
// and drops its ResizeObserver.
//
// SWARM-TODO(AQU-491): live-UI verify — open a project with long file/episode
// names -> Overview -> file-breakdown table (or Team card). Confirm a
// truncated name shows a visible dotted-underline cue and can be expanded via
// click (not hover) into a small popover with the full name; row layout
// (progress bar, Filled/Approved/Total/Words numbers) stays intact
// before/during/after expansion. OrgHome.tsx's project-name truncations are
// intentionally NOT wired to this component yet (they sit inside a whole-row
// <Link>, where nesting an interactive trigger is invalid HTML and would
// fight row navigation) — spot-check that they remain hover-only, unchanged.
export function ExpandableName({ name, className }: { name: string; className?: string }) {
  const spanRef = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const el = spanRef.current
    if (!el) return
    const check = () => setTruncated(el.scrollWidth > el.clientWidth + 1)
    check()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [name])

  return (
    <Popover open={open} onOpenChange={(next) => truncated && setOpen(next)}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={!truncated}
            aria-label={truncated ? `Show full name: ${name}` : undefined}
            className={cn(
              "block w-full min-w-0 max-w-full appearance-none border-0 bg-transparent p-0 text-start",
              truncated && "disabled:cursor-default",
            )}
          >
            <span
              ref={spanRef}
              className={cn(
                "block truncate",
                truncated &&
                  "underline decoration-dotted decoration-muted-foreground/60 underline-offset-2",
                className,
              )}
            >
              {name}
            </span>
          </button>
        }
      />
      {truncated && (
        <PopoverContent className="w-auto max-w-sm text-sm break-words" align="start">
          {name}
        </PopoverContent>
      )}
    </Popover>
  )
}
