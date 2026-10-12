// IntelligentProgress — the shared wait state for costly AI calls (LLM
// suggestions and anything else that spends credits).
//
// Design rule (Ryder, 2026-10-02): waiting for an expensive result should feel
// like something good is being made, without adding a millisecond of friction.
//
//   1. A quiet base bar fills on a short fixed curve (FIRST_MS).
//   2. If the answer is not back when it fills, a second, bolder bar runs over
//      it (SECOND_MS) — the work "filled up twice" — then breathes near the end
//      until the answer lands.
//   3. When the answer lands, whichever bar is running PLAYS THROUGH to full in
//      FINISH_MS and fades, and only then is the result revealed. It never
//      snaps off mid-fill (that reads as arbitrary) and never drags on after
//      the answer is in.
//
// Cheap, precomputed results (smart-edit memory, Jev) get no loader at all;
// this treatment is how a user can tell the expensive kind apart.

import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

import {
  FADE_MS,
  FINISH_MS,
  FIRST_MS,
  nextFrame,
  SECOND_HOLD,
  SECOND_MS,
  type ProgressFrame,
} from "./intelligent-progress-timeline"

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

export function IntelligentProgress({
  pending,
  onSettled,
  label,
  className,
}: {
  /** True while the request is in flight. */
  pending: boolean
  /** Called once the finishing animation has played — reveal the result then. */
  onSettled: () => void
  /** Screen-reader text for the wait, e.g. "Asking AI for edits". */
  label: string
  className?: string
}) {
  const [reduced] = useState(prefersReducedMotion)
  const [frame, setFrame] = useState<ProgressFrame>({ phase: "first", first: 0, second: 0, ms: 0 })
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  })

  // Kick the base bar after first paint so the 0 → 1 transition runs. A
  // timer, not requestAnimationFrame: rAF never fires in a background tab, and
  // the loader must still progress (and reveal the result) there.
  useEffect(() => {
    const t = window.setTimeout(() => setFrame((f) => (f.first === 0 ? { phase: "first", first: 1, second: 0, ms: FIRST_MS } : f)), 16)
    return () => window.clearTimeout(t)
  }, [])

  // Advance when a stage's fill completes, or when the answer lands.
  useEffect(() => {
    if (frame.phase === "first" && frame.first === 0 && pending) return // not started yet
    if (frame.phase === "done") {
      const t = window.setTimeout(() => onSettledRef.current(), reduced ? 0 : FADE_MS)
      return () => window.clearTimeout(t)
    }
    if (!pending && frame.phase !== "finishing") {
      // The answer is in: play the running bar through to full on the next tick.
      const t = window.setTimeout(() => setFrame(nextFrame(frame.phase, false)), 0)
      return () => window.clearTimeout(t)
    }
    const wait = frame.phase === "finishing" ? FINISH_MS : frame.ms
    if (frame.phase === "second" && pending && frame.second === SECOND_HOLD && frame.ms === 0) return
    const t = window.setTimeout(() => setFrame(nextFrame(frame.phase, pending)), reduced ? 0 : wait)
    return () => window.clearTimeout(t)
  }, [frame, pending, reduced])

  const holding = frame.phase === "second" && pending
  const transition = (ms: number) => (reduced ? "none" : `transform ${ms}ms cubic-bezier(0.22, 1, 0.36, 1)`)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-busy={pending}
      className={cn(
        "relative h-1 w-full overflow-hidden rounded-full bg-violet-500/10 transition-opacity",
        frame.phase === "done" && "opacity-0",
        className,
      )}
      style={{ transitionDuration: `${FADE_MS}ms` }}
      data-phase={frame.phase}
    >
      <div
        className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-violet-400/50"
        style={{ transform: `scaleX(${frame.first})`, transition: transition(frame.phase === "first" ? FIRST_MS : FINISH_MS) }}
      />
      <div
        className={cn(
          "absolute inset-y-0 left-0 w-full origin-left rounded-full bg-violet-600",
          holding && !reduced && "animate-pulse",
        )}
        style={{ transform: `scaleX(${frame.second})`, transition: transition(frame.phase === "second" ? SECOND_MS : FINISH_MS) }}
      />
    </div>
  )
}
