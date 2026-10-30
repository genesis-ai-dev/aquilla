// Why a control is locked, said once, where you will see it (AQU-2260, Sam,
// Oct 29, Settings cleanup section 1, "the related call", option A):
//   - a whole section locked for you: one line at its top ("Only Owners can
//     change Security"), and nothing more inside it;
//   - a single locked control: one short line beneath it.
// Never a hover. It used to be a tooltip on each greyed-out control in Project
// settings, and nothing at all on org Security or org Project defaults.

import { createContext, useContext, type ReactNode } from "react"
import { Lock } from "lucide-react"
import { cn } from "@/lib/utils"

/** The reason a section's top line already gives. A control inside it locked
 *  for that same reason stays quiet instead of repeating it; one locked for
 *  another reason (a different role) still says its own. */
const LockedSectionContext = createContext<ReactNode | readonly ReactNode[]>(null)

/** Where a lock line is drawn: atop a section, or beneath one control. The
 *  same reason reads "…can change these settings" or "…can change this". */
export type LockPlacement = "section" | "control"
const LockPlacementContext = createContext<LockPlacement>("control")

export function useLockPlacement(): LockPlacement {
  return useContext(LockPlacementContext)
}

function alreadySaid(said: ReactNode | readonly ReactNode[], reason: ReactNode): boolean {
  if (said == null) return false
  return Array.isArray(said) ? said.includes(reason) : said === reason
}

/** The line itself: a small lock and the reason, in muted text. */
export function LockedNote({
  children,
  placement = "control",
  className,
  testId,
}: {
  children: ReactNode
  placement?: LockPlacement
  className?: string
  testId?: string
}) {
  return (
    <LockPlacementContext.Provider value={placement}>
      <p
        data-slot="locked-note"
        data-placement={placement}
        data-testid={testId}
        className={cn("flex items-start gap-1.5 text-xs text-muted-foreground", className)}
      >
        <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{children}</span>
      </p>
    </LockPlacementContext.Provider>
  )
}

/** Marks everything inside as covered by a section line, drawn elsewhere (a
 *  card's heading, a page's top), that gives `reason`. Pass the very node or
 *  string the controls inside are given, so they know it was already said —
 *  or a list, when a toolbar's lines give several. */
export function LockedSection({ reason, children }: { reason: ReactNode | readonly ReactNode[]; children: ReactNode }) {
  return <LockedSectionContext.Provider value={reason ?? null}>{children}</LockedSectionContext.Provider>
}

/**
 * One locked control and its line beneath. Inside a section whose top line
 * already gives this same reason, the control is drawn bare. Unlocked, or with no
 * reason to give, the control is drawn as it is.
 */
export function LockedControl({
  locked,
  reason,
  children,
  align = "start",
  className,
  noteClassName,
}: {
  locked: boolean
  reason: ReactNode
  children: ReactNode
  /** "end" lines the reason up under a control at the right of its row. */
  align?: "start" | "end"
  className?: string
  noteClassName?: string
}) {
  const said = useContext(LockedSectionContext)
  if (!locked || !reason || alreadySaid(said, reason)) return <>{children}</>
  return (
    <span
      data-slot="locked-control"
      className={cn(
        "inline-flex max-w-full flex-col gap-1",
        align === "end" ? "items-end text-end" : "items-start",
        className,
      )}
    >
      {children}
      <LockedNote className={cn("max-w-64", align === "end" && "justify-end", noteClassName)}>{reason}</LockedNote>
    </span>
  )
}
