/**
 * file-view-prefs — per-file display preferences (font size, etc.).
 *
 * Stored in localStorage keyed by fileId so that every open file can have
 * its own reading size. Reactive via useSyncExternalStore so any write
 * immediately updates every mounted component that reads the same file's prefs.
 *
 * Key schema: `aq.file-view-prefs.v1`
 *
 * AQU-251: per-file font size control.
 * AQU-1170: untouched files follow the app-wide font-size scale; an explicit
 * per-file size keeps absolute priority.
 */

import { useSyncExternalStore } from "react"
import {
  scaledDefaultCellFontSizePx,
  useOptionalFontSizeScale,
  type FontSizeScale,
} from "@/branding/FontSize"

const STORAGE_KEY = "aq.file-view-prefs.v1"

export interface FileViewPrefs {
  /** Legacy single editor font size in px. Superseded by the per-side sizes
   *  below; kept as a read fallback so pre-split prefs keep working. */
  fontSize?: number
  /** Source column font size in px. Absent means follow the app font size. */
  sourceFontSize?: number
  /** Target column font size in px. Absent means follow the app font size. */
  targetFontSize?: number
}

export type FileFontSizeSide = "source" | "target"

type PrefMap = Record<string, FileViewPrefs>

export const MIN_FONT_SIZE = 11
export const MAX_FONT_SIZE = 22
export const FONT_SIZE_STEP = 1

const EMPTY: FileViewPrefs = Object.freeze({})

// ── Internal cache + listeners ──────────────────────────────────────────────

const snapshotCache = new Map<string, FileViewPrefs>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function load(): PrefMap {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as PrefMap
  } catch {
    return {}
  }
}

function save(map: PrefMap): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // quota / access denied — in-memory cache still reflects the edit
  }
}

function peek(fileId: string): FileViewPrefs {
  const cached = snapshotCache.get(fileId)
  if (cached) return cached
  const fromLs = load()[fileId] ?? EMPTY
  snapshotCache.set(fileId, fromLs)
  return fromLs
}

// ── Public API ───────────────────────────────────────────────────────────────

export function getFileViewPref(fileId: string): FileViewPrefs {
  const v = peek(fileId)
  return v === EMPTY ? {} : v
}

export function setFileViewPref(fileId: string, patch: FileViewPrefs): void {
  const map = load()
  const next: FileViewPrefs = { ...map[fileId], ...patch }
  // Drop undefined keys so JSON stays clean.
  for (const key of Object.keys(next) as (keyof FileViewPrefs)[]) {
    if (next[key] === undefined) delete next[key]
  }
  if (Object.keys(next).length === 0) delete map[fileId]
  else map[fileId] = next
  save(map)
  snapshotCache.set(fileId, Object.keys(next).length ? next : EMPTY)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Subscribe to one file's view prefs. Returns a stable object (EMPTY when unset). */
export function useFileViewPref(fileId: string | null | undefined): FileViewPrefs {
  return useSyncExternalStore(
    subscribe,
    () => (fileId ? peek(fileId) : EMPTY),
    () => EMPTY,
  )
}

export interface ResolvedFontSizes {
  source: number
  target: number
}

/**
 * Resolve per-side font sizes from raw prefs. Each side falls back to the
 * legacy single `fontSize` (pre-split prefs), then to the app-scale default
 * (14px at Default) — so a file sized before the source/target split keeps
 * its size on both sides, and an untouched file tracks the app font size.
 */
export function resolveFontSizes(
  prefs: FileViewPrefs,
  appScale: FontSizeScale = "default",
): ResolvedFontSizes {
  const fallback = scaledDefaultCellFontSizePx(appScale)
  return {
    source: prefs.sourceFontSize ?? prefs.fontSize ?? fallback,
    target: prefs.targetFontSize ?? prefs.fontSize ?? fallback,
  }
}

/** Resolved source/target font sizes for a file (app-scale default when unset). */
export function useFileFontSizes(fileId: string | null | undefined): ResolvedFontSizes {
  const prefs = useFileViewPref(fileId)
  const appScale = useOptionalFontSizeScale()
  return resolveFontSizes(prefs, appScale)
}

/** True when this column has a stored px and no longer tracks the app font size. */
export function isExplicitFileFontSize(
  prefs: FileViewPrefs,
  side: FileFontSizeSide,
): boolean {
  if (side === "source") return prefs.sourceFontSize != null || prefs.fontSize != null
  return prefs.targetFontSize != null || prefs.fontSize != null
}

export function useFileFontSizeExplicit(
  fileId: string | null | undefined,
): { source: boolean; target: boolean } {
  const prefs = useFileViewPref(fileId)
  return {
    source: isExplicitFileFontSize(prefs, "source"),
    target: isExplicitFileFontSize(prefs, "target"),
  }
}

/**
 * Drop a column's stored size so it follows the app font size again.
 * A legacy shared `fontSize` is kept on the other column as a per-side value.
 */
export function clearFileFontSize(fileId: string, side: FileFontSizeSide): void {
  const prefs = getFileViewPref(fileId)
  if (!isExplicitFileFontSize(prefs, side)) return

  if (side === "source") {
    const keepTarget =
      prefs.targetFontSize == null && prefs.fontSize != null ? prefs.fontSize : undefined
    setFileViewPref(fileId, {
      sourceFontSize: undefined,
      fontSize: undefined,
      ...(keepTarget != null ? { targetFontSize: keepTarget } : {}),
    })
    return
  }

  const keepSource =
    prefs.sourceFontSize == null && prefs.fontSize != null ? prefs.fontSize : undefined
  setFileViewPref(fileId, {
    targetFontSize: undefined,
    fontSize: undefined,
    ...(keepSource != null ? { sourceFontSize: keepSource } : {}),
  })
}
