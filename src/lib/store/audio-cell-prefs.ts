// Per-cell, client-owned audio playback prefs (volume now; non-destructive trim
// points for cropping in a later phase). These are durable client-only settings
// that must survive reload, so — like project-tts-store / user-api-keys — they
// live in localStorage keyed by projectId, NOT the server-sourced IDB project
// record (whose patchProject no-ops without a row and is rewritten on pull).
//
// Threat model matches project-tts-store: localStorage is readable by any script
// on this origin; nothing sensitive is kept here (just volume/trim numbers).

const PREFIX = "frontier:audio-cell-prefs:"

export interface CellAudioPref {
  /** Playback volume 0..1. Treated as 1 when unset. */
  volume?: number
  /** Non-destructive trim, in seconds, applied on playback/export (Phase 2). */
  trimStart?: number
  trimEnd?: number
}

type PrefMap = Record<string, CellAudioPref>

function storageKey(projectId: string): string {
  return PREFIX + projectId
}

export function loadCellPrefs(projectId: string): PrefMap {
  try {
    if (typeof localStorage === "undefined") return {}
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return {}
    return JSON.parse(raw) as PrefMap
  } catch {
    return {}
  }
}

export function getCellPref(projectId: string, cellId: string): CellAudioPref | undefined {
  return loadCellPrefs(projectId)[cellId]
}

/** Merge a patch into one cell's prefs and persist. */
export function setCellPref(projectId: string, cellId: string, patch: CellAudioPref): void {
  try {
    if (typeof localStorage === "undefined") return
    const map = loadCellPrefs(projectId)
    map[cellId] = { ...map[cellId], ...patch }
    localStorage.setItem(storageKey(projectId), JSON.stringify(map))
  } catch {
    /* quota / access denied — ignore; in-memory state still reflects the edit */
  }
}
