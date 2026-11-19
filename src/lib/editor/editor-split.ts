// AQU-2678 (ETEN): the line before the text editor's Target column can be
// dragged, so a translator can widen (or narrow) Target.
//
// The split is one number: Target's share of the width the shared text
// tracks take (Source, any Bible columns, Target; the gaps excluded). What
// Target does not take is split equally across Source and the Bible columns.
// Nothing saved means today's equal tracks. With no Bible columns this is
// simply Source | Target.
//
// The tracks read it as `--editor-tgt-fr` (Target) and `--editor-rest-fr`
// (Source and each Bible column), chosen so the shared tracks still sum to
// their count in fr. The Back-translation track therefore keeps the width it
// has today and `--editor-rail-end`'s equal-track calc still holds
// (editor-grid.ts).
//
// It is remembered per person on this device (not across devices: how wide a
// column should be depends on the screen), through the account-scoped
// browser key every other per-person local value uses.

import { ownerScopedLocalStorageKey } from "@/lib/frontier/client-local-storage"

/** No shared track may be dragged narrower than this: the width a Bible
 *  column needs to be shown as a column (MIN_TEXT_COLUMN_PX), so the two
 *  rules agree. */
export const EDITOR_SPLIT_MIN_PX = 200
/** Arrow-key steps, in px of column width. */
export const EDITOR_SPLIT_STEP_PX = 16
export const EDITOR_SPLIT_BIG_STEP_PX = 64
/** The grid gap between tracks (`gap-x-2`). */
export const EDITOR_SPLIT_GAP_PX = 8

const STORAGE_KEY = "editor:target-split"

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * The shares Target may take, or null when the minimums do not fit.
 * `tracks` is the number of shared tracks: Source + Bible columns + Target.
 */
export function editorSplitBounds(
  textWidth: number,
  tracks = 2,
  minPx: number = EDITOR_SPLIT_MIN_PX,
): { min: number; max: number } | null {
  if (!(textWidth >= minPx * tracks) || tracks < 2) return null
  return { min: minPx / textWidth, max: 1 - (minPx * (tracks - 1)) / textWidth }
}

/**
 * The split in force: a saved share clamped to what fits now, or null for
 * today's equal tracks (nothing saved, or too narrow for the minimums). The
 * saved value itself is left alone, so a wider screen gets it back.
 */
export function clampEditorSplit(
  share: number | null,
  textWidth: number,
  tracks = 2,
  minPx: number = EDITOR_SPLIT_MIN_PX,
): number | null {
  if (share === null || !Number.isFinite(share)) return null
  const bounds = editorSplitBounds(textWidth, tracks, minPx)
  if (!bounds) return null
  return clamp(share, bounds.min, bounds.max)
}

/**
 * The share under a pointer. `targetEnd` is Target's reading-end edge (its
 * right in LTR, its left in RTL); the line sits mid-gap before Target.
 */
export function editorSplitFromPointer(args: {
  pointerX: number
  targetEnd: number
  textWidth: number
  tracks?: number
  rtl: boolean
}): number {
  const { pointerX, targetEnd, textWidth, tracks = 2, rtl } = args
  const targetPx = (rtl ? pointerX - targetEnd : targetEnd - pointerX) - EDITOR_SPLIT_GAP_PX / 2
  return clampEditorSplit(targetPx / textWidth, textWidth, tracks) ?? 1 / tracks
}

/**
 * One arrow-key move: the line goes the way the arrow points, so in LTR
 * Right narrows Target and in RTL (Target on the left) Left narrows it.
 * Undefined for any other key.
 */
export function editorSplitStep(
  share: number | null,
  key: string,
  shift: boolean,
  rtl: boolean,
  textWidth: number,
  tracks = 2,
): number | undefined {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined
  const rightward = key === "ArrowRight" ? 1 : -1
  const px = (shift ? EDITOR_SPLIT_BIG_STEP_PX : EDITOR_SPLIT_STEP_PX) * rightward * (rtl ? -1 : 1)
  return clampEditorSplit((share ?? 1 / tracks) - px / textWidth, textWidth, tracks) ?? undefined
}

/** Target's and each other shared track's share, for the screen reader. */
export function editorSplitShares(share: number | null, tracks = 2): { target: number; rest: number } {
  const target = share ?? 1 / tracks
  return { target, rest: (1 - target) / (tracks - 1) }
}

/** The tracks' fr values, or null to leave the template's 1fr fallback. */
export function editorSplitVars(share: number | null, tracks = 2): { target: string; rest: string } | null {
  if (share === null) return null
  const fr = (n: number) => `${Number(n.toFixed(4))}fr`
  return { target: fr(share * tracks), rest: fr(((1 - share) * tracks) / (tracks - 1)) }
}

/** Write the split onto the table root; null removes it (today's split). */
export function applyEditorSplit(el: HTMLElement, share: number | null, tracks = 2): void {
  const vars = editorSplitVars(share, tracks)
  if (vars) {
    el.style.setProperty("--editor-rest-fr", vars.rest)
    el.style.setProperty("--editor-tgt-fr", vars.target)
  } else {
    el.style.removeProperty("--editor-rest-fr")
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
export function writeEditorSplit(share: number | null): void {
  try {
    const key = ownerScopedLocalStorageKey(STORAGE_KEY)
    if (share === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(Number(share.toFixed(4))))
  } catch {
    // Storage off or full: the split still holds for this visit.
  }
}
