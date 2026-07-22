/**
 * hidden-stats — AQU-593 customizable statistical widgets.
 *
 * Biblica ETT feedback (2026-07-09): some of the Progress-card stat widgets
 * aren't helpful, so let users hide the ones they don't care about. This is a
 * per-user, client-side preference (localStorage) — it never touches the event
 * log or sync-worker; it only decides which tiles/bars the Progress card paints.
 *
 * The preference is global to the user (not per-project): "this stat isn't
 * useful to me" is a viewing preference, not project state. Audio-only tiles
 * already self-gate on whether the project has audio, so hiding "Has Audio"
 * globally simply means the user never wants to see it.
 */

/** Every customizable widget in the Progress card, keyed stably for storage. */
export type StatKey =
  | "translated"
  | "ai-drafted"
  | "validated"
  | "has-audio"
  | "audio-validated"

export interface StatWidgetDef {
  key: StatKey
  /** Human label shown in the Customize menu (matches the tile label). */
  label: string
}

/** Canonical widget list — order matches how the tiles render in the card. */
export const STAT_WIDGETS: readonly StatWidgetDef[] = [
  { key: "translated", label: "Translated" },
  { key: "ai-drafted", label: "AI Drafted" },
  { key: "validated", label: "Validated" },
  { key: "has-audio", label: "Has Audio" },
  { key: "audio-validated", label: "Audio Validated" },
]

const STAT_KEYS: ReadonlySet<StatKey> = new Set(STAT_WIDGETS.map((w) => w.key))

const STORAGE_KEY = "aquilla:hiddenStats"

function isStatKey(value: unknown): value is StatKey {
  return typeof value === "string" && STAT_KEYS.has(value as StatKey)
}

/**
 * Read the set of hidden stat keys. Tolerant of missing/corrupt storage and of
 * unknown keys (e.g. a widget removed in a later release) — those are dropped
 * rather than thrown, so a bad value never blanks the whole overview.
 */
export function loadHiddenStats(): Set<StatKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter(isStatKey))
  } catch {
    return new Set()
  }
}

/** Persist the hidden-stat set. Silently no-ops if storage is unavailable. */
export function saveHiddenStats(hidden: Set<StatKey>): void {
  try {
    // Only persist known keys, in canonical order, so storage stays clean.
    const ordered = STAT_WIDGETS.map((w) => w.key).filter((k) => hidden.has(k))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ordered))
  } catch {
    /* storage unavailable (private mode, quota) — preference is best-effort */
  }
}

/**
 * Return a new hidden-set with `key` flipped between hidden and visible.
 * Pure — callers persist the result with `saveHiddenStats`.
 */
export function toggleHiddenStat(hidden: Set<StatKey>, key: StatKey): Set<StatKey> {
  const next = new Set(hidden)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
