import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

import "./fills-twice-indicator.css"

/**
 * How long the first simulated fill takes while the call is still out.
 * A typical draft returns during this pass; a slow one continues into the
 * second. Visual only — it never holds the response.
 */
export const FILLS_TWICE_FIRST_MS = 4_000

/** Second, bolder pass when the call is still pending after the first fill. */
export const FILLS_TWICE_SECOND_MS = 4_000

/** Once the real response is back, close the graphic inside 150–250ms. */
export const FILLS_TWICE_FINISH_MS = 200

/** Brief moment the completed bar stays up so the finish is visible. */
const COMPLETE_LINGER_MS = 120

type Phase = "idle" | "first" | "second" | "finishing" | "complete"

function readPrefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readPrefersReducedMotion)

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    if (typeof mq.addEventListener !== "function") return
    const apply = () => setReduced(mq.matches)
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [])

  return reduced
}

/**
 * AQU-1640. Shared wait graphic for a costly model call.
 *
 * `pending` is the real in-flight flag. The fill is simulated and does not
 * delay the result: when `pending` becomes false the caller has already
 * shown the response, and this only runs the bar out in about 200ms.
 * Reduced motion gets a static mark, not a filling bar.
 *
 * The root is `pointer-events-none` so the graphic never takes a click.
 */
export function FillsTwiceIndicator({
  pending,
  label,
  className,
}: {
  pending: boolean
  /** Accessible name. Callers pass an existing translated string. */
  label: string
  className?: string
}) {
  const reduced = usePrefersReducedMotion()
  const [phase, setPhase] = useState<Phase>(() =>
    pending && !readPrefersReducedMotion() ? "first" : "idle",
  )
  const [pass, setPass] = useState<1 | 2>(1)
  const [trackedPending, setTrackedPending] = useState(pending)
  const [trackedReduced, setTrackedReduced] = useState(reduced)

  // Follow the real pending flag during render so the graphic starts and
  // finishes with the call. The timers below only move the simulated fill.
  if (trackedPending !== pending || trackedReduced !== reduced) {
    setTrackedPending(pending)
    setTrackedReduced(reduced)
    if (reduced) {
      setPhase("idle")
      setPass(1)
    } else if (pending) {
      setPass(1)
      setPhase("first")
    } else if (phase === "first" || phase === "second") {
      setPhase("finishing")
    }
  }

  useEffect(() => {
    if (reduced || !pending || phase !== "first") return
    const toSecond = window.setTimeout(() => {
      setPass(2)
      setPhase("second")
    }, FILLS_TWICE_FIRST_MS)
    return () => window.clearTimeout(toSecond)
  }, [reduced, pending, phase])

  useEffect(() => {
    if (phase !== "finishing") return
    const done = window.setTimeout(() => setPhase("complete"), FILLS_TWICE_FINISH_MS)
    return () => window.clearTimeout(done)
  }, [phase])

  useEffect(() => {
    if (phase !== "complete") return
    const hide = window.setTimeout(() => {
      setPhase("idle")
      setPass(1)
    }, COMPLETE_LINGER_MS)
    return () => window.clearTimeout(hide)
  }, [phase])

  if (reduced) {
    if (!pending) return null
    return (
      <div
        role="status"
        aria-label={label}
        data-slot="fills-twice"
        data-motion="reduced"
        className={cn("pointer-events-none w-full", className)}
      >
        <span aria-hidden className="block h-1 w-8 rounded-full bg-primary/70" />
      </div>
    )
  }

  if (phase === "idle" || ((phase === "first" || phase === "second") && !pending)) return null

  const finishing = phase === "finishing" || phase === "complete"
  const firstAnimating = phase === "first"
  const secondAnimating = phase === "second"

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={finishing ? 100 : undefined}
      aria-busy={phase !== "complete"}
      data-slot="fills-twice"
      data-motion="animated"
      data-pass={pass === 2 ? "2" : "1"}
      data-state={phase === "complete" ? "complete" : phase === "finishing" ? "finishing" : "filling"}
      className={cn("pointer-events-none w-full", className)}
    >
      <span className="relative block h-1.5 w-full">
        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
          <span
            data-fill="first"
            aria-hidden
            className={cn(
              "absolute inset-y-0 start-0 rounded-full bg-primary/45",
              firstAnimating && "fills-twice-grow",
              !firstAnimating && "fills-twice-finish",
            )}
            style={firstAnimating
              ? { animationDuration: `${FILLS_TWICE_FIRST_MS}ms` }
              : { transitionDuration: `${FILLS_TWICE_FINISH_MS}ms` }}
          />
        </span>
        {pass === 2 && (
          <span className="absolute inset-x-0 top-1/2 z-[1] h-1.5 -translate-y-1/2 overflow-hidden rounded-full">
            <span
              data-fill="second"
              aria-hidden
              className={cn(
                "absolute inset-y-0 start-0 rounded-full bg-primary",
                secondAnimating && "fills-twice-grow",
                !secondAnimating && "fills-twice-finish",
              )}
              style={secondAnimating
                ? { animationDuration: `${FILLS_TWICE_SECOND_MS}ms` }
                : { transitionDuration: `${FILLS_TWICE_FINISH_MS}ms` }}
            />
          </span>
        )}
      </span>
    </div>
  )
}
