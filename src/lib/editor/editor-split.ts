// AQU-2678 (ETEN): the line between the text editor's Source and Target
// columns can be dragged, so a translator can widen the Target side.
//
// The split is one number: Source's share of the width the two columns share
// (the gap between them excluded). Nothing saved means today's even split.
// The two tracks read it as `--editor-src-fr` / `--editor-tgt-fr`, which
// always sum to 2fr, so every other text track (Back-translation) keeps the
// width it has today and `--editor-rail-end`'s equal-track calc still holds
// (editor-grid.ts).
//
// It is remembered per person on this device (not across devices: how wide a
// column should be depends on the screen), through the account-scoped
// browser key every other per-person local value uses.

import { ownerScopedLocalStorageKey } from "@/lib/frontier/client-local-storage"

/** Neither column may be dragged narrower than this. */
export const EDITOR_SPLIT_MIN_PX = 240
/** Arrow-key steps, in px of column width. */
export const EDITOR_SPLIT_STEP_PX = 16
export const EDITOR_SPLIT_BIG_STEP_PX = 64
/** The grid gap between Source and Target (`gap-x-2`). */
export const EDITOR_SPLIT_GAP_PX = 8

const STORAGE_KEY = "editor:source-target-split"

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** The shares Source may take at this width, or null when the two minimums do not fit. */
export function editorSplitBounds(
  textWidth: number,
  minPx: number = EDITOR_SPLIT_MIN_PX,
): { min: number; max: number } | null {
  if (!(textWidth >= minPx * 2)) return null
  return { min: minPx / textWidth, max: 1 - minPx / textWidth }
}

/**
 * The split in force: a saved share clamped to what fits now, or null for
 * today's even split (nothing saved, or too narrow for both minimums). The
 * saved value itself is left alone, so a wider screen gets it back.
 */
export function clampEditorSplit(
  ratio: number | null,
  textWidth: number,
  minPx: number = EDITOR_SPLIT_MIN_PX,
): number | null {
  if (ratio === null || !Number.isFinite(ratio)) return null
  const bounds = editorSplitBounds(textWidth, minPx)
  if (!bounds) return null
  return clamp(ratio, bounds.min, bounds.max)
}

/**
 * The share under a pointer. `sourceStart` is Source's reading-start edge
 * (its left in LTR, its right in RTL); the line sits mid-gap after Source.
 */
export function editorSplitFromPointer(args: {
  pointerX: number
  sourceStart: number
  textWidth: number
  rtl: boolean
}): number {
  const { pointerX, sourceStart, textWidth, rtl } = args
  const sourcePx = (rtl ? sourceStart - pointerX : pointerX - sourceStart) - EDITOR_SPLIT_GAP_PX / 2
  return clampEditorSplit(sourcePx / textWidth, textWidth) ?? 0.5
}

/**
 * One arrow-key move: the line goes the way the arrow points, so in RTL
 * (Source on the right) Left widens Source. Undefined for any other key.
 */
export function editorSplitStep(
  ratio: number | null,
  key: string,
  shift: boolean,
  rtl: boolean,
  textWidth: number,
): number | undefined {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined
  const rightward = key === "ArrowRight" ? 1 : -1
  const px = (shift ? EDITOR_SPLIT_BIG_STEP_PX : EDITOR_SPLIT_STEP_PX) * rightward * (rtl ? -1 : 1)
  return clampEditorSplit((ratio ?? 0.5) + px / textWidth, textWidth) ?? undefined
}

/** The two tracks' fr values, or null to leave the template's 1fr fallback. */
export function editorSplitVars(ratio: number | null): { source: string; target: string } | null {
  if (ratio === null) return null
  const fr = (n: number) => `${Number(n.toFixed(4))}fr`
  return { source: fr(ratio * 2), target: fr((1 - ratio) * 2) }
}

/** Write the split onto the table root; null removes it (today's split). */
export function applyEditorSplit(el: HTMLElement, ratio: number | null): void {
  const vars = editorSplitVars(ratio)
  if (vars) {
    el.style.setProperty("--editor-src-fr", vars.source)
    el.style.setProperty("--editor-tgt-fr", vars.target)
  } else {
    el.style.removeProperty("--editor-src-fr")
    el.style.removeProperty("--editor-tgt-fr")
  }
}

/** This person's saved split on this device, or null. Never throws. */
export function readEditorSplit(): number | null {
  try {
    const raw = localStorage.getItem(ownerScopedLocalStorageKey(STORAGE_KEY))
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 && n < 1 ? n : null
  } catch {
    return null
  }
}

/** Save the split; null forgets it (back to today's split). Never throws. */
export function writeEditorSplit(ratio: number | null): void {
  try {
    const key = ownerScopedLocalStorageKey(STORAGE_KEY)
    if (ratio === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(Number(ratio.toFixed(4))))
  } catch {
    // Storage off or full: the split still holds for this visit.
  }
}
