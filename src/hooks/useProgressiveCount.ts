import { startTransition, useEffect, useState } from "react"

/**
 * How many rows of a long, un-virtualized list to draw right now (AQU-2654).
 *
 * For lists that have to stay in the DOM in full — the glossary is searched
 * with the browser's own find-in-page, so virtualizing it would hide terms
 * from Ctrl+F — but are long enough that mounting every row in one render
 * freezes the click that opened them (664 terms: 2.4s of blocked main thread
 * at 4× CPU slowdown).
 *
 * The first render draws `initial` rows, which fills the screen. The rest
 * arrive in a transition: React renders them in slices, yields to input
 * between slices, and commits them once, so the list completes itself a moment
 * later without ever holding the main thread. A list of `initial` rows or
 * fewer is drawn whole, as before. Once everything has been shown it stays
 * shown — later growth (a term added) is drawn at once.
 */
export function useProgressiveCount(total: number, initial = 80): number {
  const [revealed, setRevealed] = useState(false)
  const staged = !revealed && total > initial
  useEffect(() => {
    if (!staged) return
    startTransition(() => setRevealed(true))
  }, [staged])
  return staged ? initial : total
}
