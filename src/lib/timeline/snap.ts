// Edge snapping for timeline drags (AQU-646 round 6). Not a grid: while
// moving or resizing, an edge that lands near a CANDIDATE edge (neighboring
// chips, the cell's own section boundaries) magnets flush to it. Pure — the
// same function transforms both the drag preview and the commit, so what you
// see is exactly what lands.

export const SNAP_THRESHOLD_PX = 8

export type SnapMode = "move" | "resize-l" | "resize-r"

export interface SnapSpan {
  start: number
  end: number
  /** Which edge snapped (move: whichever edge won), or null. */
  snapped: "start" | "end" | null
}

interface EdgeHit {
  delta: number
}

function nearest(edge: number, candidates: number[], thresholdSec: number): EdgeHit | null {
  let best: EdgeHit | null = null
  for (const c of candidates) {
    const delta = c - edge
    if (Math.abs(delta) > thresholdSec) continue
    if (best == null || Math.abs(delta) < Math.abs(best.delta)) best = { delta }
  }
  return best
}

/**
 * Snap a proposed span. `move` shifts the whole span by whichever edge found
 * the closest candidate; `resize-l`/`resize-r` adjust only their own edge.
 */
export function snapSpan(
  span: { start: number; end: number },
  mode: SnapMode,
  candidates: number[],
  thresholdSec: number,
): SnapSpan {
  if (thresholdSec <= 0 || candidates.length === 0) return { ...span, snapped: null }
  if (mode === "resize-l") {
    const hit = nearest(span.start, candidates, thresholdSec)
    return hit ? { start: span.start + hit.delta, end: span.end, snapped: "start" } : { ...span, snapped: null }
  }
  if (mode === "resize-r") {
    const hit = nearest(span.end, candidates, thresholdSec)
    return hit ? { start: span.start, end: span.end + hit.delta, snapped: "end" } : { ...span, snapped: null }
  }
  const startHit = nearest(span.start, candidates, thresholdSec)
  const endHit = nearest(span.end, candidates, thresholdSec)
  const winner =
    startHit && endHit
      ? Math.abs(startHit.delta) <= Math.abs(endHit.delta)
        ? { hit: startHit, which: "start" as const }
        : { hit: endHit, which: "end" as const }
      : startHit
        ? { hit: startHit, which: "start" as const }
        : endHit
          ? { hit: endHit, which: "end" as const }
          : null
  if (!winner) return { ...span, snapped: null }
  return {
    start: span.start + winner.hit.delta,
    end: span.end + winner.hit.delta,
    snapped: winner.which,
  }
}

// ── Preference (GLOBAL, not per file — snapping is an editing-mode choice) ──

const SNAP_KEY = "codex:timelineSnap"

export function loadSnapEnabled(): boolean {
  try {
    return localStorage.getItem(SNAP_KEY) !== "off"
  } catch {
    return true
  }
}

export function saveSnapEnabled(on: boolean): void {
  try {
    localStorage.setItem(SNAP_KEY, on ? "on" : "off")
  } catch {
    /* private mode — just won't persist */
  }
}
