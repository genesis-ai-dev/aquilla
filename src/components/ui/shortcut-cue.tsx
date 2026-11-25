// AQU-2703: a keyboard shortcut that changes how the app behaves says so on
// screen, and says how to undo it.
//
// A single key could change what a click does with nothing to show it had
// happened: B turned the timeline's Blade on, every click on a take then cut
// it in two, and the only sign was a small toolbar button turning blue (and
// that button is folded into the ⋯ menu on a narrow timeline). Someone who did
// not know the shortcut could not tell why, or how to get back.
//
// Two kinds of shortcut, two cues, both quiet — nothing takes focus or blocks
// typing:
//
//  - A MODE (Blade): <ModeCue> is a small chip over the area the mode
//    affects. It is there for as long as the mode is on, names the mode in
//    plain words, says which key turns it off, and has its own off button.
//    When the mode goes off it says so for a moment, then fades away.
//
//  - A ONE-OFF ACTION that changes content (S splits a take):
//    announceShortcutAction() shows a short toast saying what changed, with
//    the undo key and an Undo button.
//
// Both follow the state, not the key: a mode turned on from its toolbar
// button or menu shows the same chip, so the cue never depends on how the
// person got there.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { X } from "lucide-react"
import { toast } from "@/components/ui/toast"
import { isApplePlatform } from "@/lib/platform"
import { cn } from "@/lib/utils"

/** How long "Blade off" (or any mode's off note) stays before it fades. */
export const MODE_OFF_NOTE_MS = 1600

/** The platform's undo keys, as people see them on their keyboard. */
export function undoKeysLabel(apple = isApplePlatform()): string {
  return apple ? "⌘Z" : "Ctrl+Z"
}

export interface ModeCueProps {
  /** The mode is on. */
  active: boolean
  /** Shown while on, e.g. "Blade on — click a take to cut it". */
  onLabel: ReactNode
  /** The key(s) that turn it off, e.g. "B or Esc". */
  offKeys: string
  /** Shown for a moment after it goes off, e.g. "Blade off". */
  offLabel: ReactNode
  /** Accessible name of the chip's own off button. */
  turnOffLabel: string
  onTurnOff: () => void
  testId: string
  className?: string
}

/**
 * The chip for a mode a shortcut can turn on. Place it over the area the
 * mode changes (absolutely positioned inside it); it centres itself at the
 * bottom of that area.
 */
export function ModeCue({ active, onLabel, offKeys, offLabel, turnOffLabel, onTurnOff, testId, className }: ModeCueProps) {
  // "off" is the brief note after the mode ends; it is only ever entered from
  // "on", so the chip never says "Blade off" when the timeline first opens.
  const [phase, setPhase] = useState<"hidden" | "on" | "off">(active ? "on" : "hidden")
  const wasActive = useRef(active)
  useEffect(() => {
    const was = wasActive.current
    wasActive.current = active
    if (active) {
      setPhase("on")
      return
    }
    if (!was) return
    setPhase("off")
    const timer = setTimeout(() => setPhase("hidden"), MODE_OFF_NOTE_MS)
    return () => clearTimeout(timer)
  }, [active])

  if (phase === "hidden") return null
  const on = phase === "on"
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      data-state={phase}
      className={cn(
        // `className` may move it (e.g. "bottom-12"); cn() lets the later class win.
        "pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center px-3",
        className,
      )}
    >
      <div
        className={cn(
          "pointer-events-auto flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-xs shadow-md",
          "animate-in fade-in-0 slide-in-from-bottom-1 duration-150",
          on
            ? "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100"
            : "border-border bg-background text-muted-foreground",
        )}
      >
        <span className="min-w-0 truncate font-medium">{on ? onLabel : offLabel}</span>
        {on && (
          <>
            <kbd className="shrink-0 rounded border border-sky-300/80 bg-white/70 px-1 font-sans text-[10px] font-medium text-sky-800 dark:border-sky-700 dark:bg-sky-900/60 dark:text-sky-200">
              {offKeys}
            </kbd>
            <button
              type="button"
              aria-label={turnOffLabel}
              data-testid={`${testId}-off`}
              onClick={onTurnOff}
              className="-me-1 shrink-0 rounded-full p-0.5 text-sky-700 hover:bg-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-sky-300 dark:hover:bg-sky-900"
            >
              <X className="size-3" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * A shortcut just changed content (split, delete, move): say what changed and
 * how to undo it. One toast per kind of action (`id`), so pressing the key
 * again refreshes it instead of stacking a column of them.
 */
export function announceShortcutAction(args: {
  id: string
  title: string
  /** e.g. "⌘Z to undo"; shown under the title. */
  undoHint: string
  undoLabel: string
  onUndo: () => void
}): void {
  toast.add({
    id: `shortcut-cue:${args.id}`,
    type: "info",
    title: args.title,
    description: args.undoHint,
    timeout: 4000,
    actionProps: { children: args.undoLabel, onClick: args.onUndo },
  })
}
