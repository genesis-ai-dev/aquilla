/**
 * useSmoothedText.ts — chat stream smoothing
 *
 * Presentation-only smoothing for streamed assistant replies. Network chunks
 * arrive in bursts of wildly variable size; rendering them directly looks
 * jittery. This hook reveals a prefix of the target text on a
 * requestAnimationFrame loop at an adaptive rate:
 *
 *  - rate is proportional to the backlog (unrevealed graphemes), decaying
 *    toward the head with time constant CATCHUP_TAU_S — bursts catch up fast
 *    but never teleport;
 *  - a MIN_RATE floor keeps the reveal at fast-fluid-typing speed when the
 *    backlog is small.
 *
 * The reveal boundary advances by GRAPHEME CLUSTERS (Intl.Segmenter), never by
 * JS string index: this app renders Devanagari, Arabic, Ge'ez, emoji ZWJ
 * sequences, etc., and slicing mid-surrogate or mid-combining-mark shows
 * mojibake. Segmentation is incremental — only the newly appended suffix is
 * segmented, re-segmenting from the start of the previous tail cluster because
 * a new chunk can merge with it (ZWJ joins, combining marks, regional
 * indicator pairs). While streaming, the final cluster is held back from
 * reveal for the same reason: it may still grow.
 *
 * When `isStreaming` flips false (done, stopped, errored) the full text is
 * flushed immediately. The RAF loop only runs while there is backlog — no
 * timers when idle or unmounted.
 */

import { useEffect, useRef, useState } from "react"

/** Floor reveal speed, graphemes/sec (~2-4 words per 100ms reads as fast fluid typing). */
const MIN_RATE = 160
/** Backlog decays toward the head with this time constant (seconds). */
const CATCHUP_TAU_S = 0.3
/** Clamp frame dt (ms) so tab-suspend gaps don't teleport the reveal. */
const MAX_FRAME_DT_MS = 100

let cachedSegmenter: Intl.Segmenter | null | undefined

function getSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter === undefined) {
    cachedSegmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null
  }
  return cachedSegmenter
}

/**
 * Split `text` into grapheme clusters. Falls back to code-point-safe slicing
 * (Array.from — never splits surrogate pairs, though combining marks may
 * separate) when Intl.Segmenter is unavailable.
 */
export function segmentGraphemes(text: string): string[] {
  const segmenter = getSegmenter()
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment)
  return Array.from(text)
}

/**
 * Returns the currently-revealed prefix of `targetText`, advanced smoothly
 * over time while `isStreaming` is true and flushed to the full text the
 * moment it turns false. Purely presentational — does not touch the stream.
 */
export function useSmoothedText(targetText: string, isStreaming: boolean): string {
  const [revealed, setRevealed] = useState("")

  // Incremental segmentation cache: `graphemes` covers exactly `segmentedText`,
  // which is always a prefix (string-equal) of the last seen targetText.
  const graphemesRef = useRef<string[]>([])
  const segmentedTextRef = useRef("")
  /** Fractional reveal position, in graphemes — fractions accumulate across frames. */
  const revealCountRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const lastFrameTsRef = useRef(0)

  useEffect(() => {
    // --- Sync the segmentation cache with the incoming target ---
    if (!targetText.startsWith(segmentedTextRef.current)) {
      // Not an append (new message / reset): start over.
      graphemesRef.current = []
      segmentedTextRef.current = ""
      revealCountRef.current = 0
      setRevealed("")
    }
    if (targetText.length > segmentedTextRef.current.length) {
      // Re-segment from the start of the previous tail cluster — the new
      // chunk may merge with it (ZWJ sequence, combining mark, regional
      // indicator pair). Only the suffix is segmented, never the whole text.
      const tail = graphemesRef.current.pop() ?? ""
      const suffix = tail + targetText.slice(segmentedTextRef.current.length)
      for (const g of segmentGraphemes(suffix)) graphemesRef.current.push(g)
      segmentedTextRef.current = targetText
      // The pop can momentarily shrink the array below an already-caught-up
      // reveal position; clamp so we never index past the end.
      revealCountRef.current = Math.min(revealCountRef.current, graphemesRef.current.length)
    }

    // --- Drive the reveal ---
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    if (!isStreaming) {
      // Done / stopped / errored: flush the full text immediately.
      revealCountRef.current = graphemesRef.current.length
      lastFrameTsRef.current = 0
      setRevealed(targetText)
      return
    }

    const frame = (now: number) => {
      rafRef.current = null
      const dtMs =
        lastFrameTsRef.current > 0
          ? Math.min(now - lastFrameTsRef.current, MAX_FRAME_DT_MS)
          : 16
      lastFrameTsRef.current = now
      const dt = Math.max(dtMs, 0) / 1000

      // Hold the tail cluster back while streaming: the next chunk may still
      // merge into it.
      const revealTarget = Math.max(0, graphemesRef.current.length - 1)
      const backlog = revealTarget - revealCountRef.current
      if (backlog > 0) {
        const proportional = backlog * (1 - Math.exp(-dt / CATCHUP_TAU_S))
        const step = Math.min(backlog, Math.max(MIN_RATE * dt, proportional))
        revealCountRef.current += step
        setRevealed(
          graphemesRef.current.slice(0, Math.floor(revealCountRef.current)).join(""),
        )
      }

      if (revealCountRef.current < revealTarget) {
        rafRef.current = requestAnimationFrame(frame)
      } else {
        // Caught up — idle (no RAF) until the next chunk re-runs this effect.
        lastFrameTsRef.current = 0
      }
    }

    if (revealCountRef.current < Math.max(0, graphemesRef.current.length - 1)) {
      lastFrameTsRef.current = 0
      rafRef.current = requestAnimationFrame(frame)
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [targetText, isStreaming])

  return revealed
}
