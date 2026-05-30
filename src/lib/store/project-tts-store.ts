// Per-project TTS settings (voice library, cast assignments, default voice,
// engine, API key), persisted in localStorage keyed by projectId.
//
// Why not the IDB project record? Under the AD-3 thin client the project record
// is server-sourced and re-hydrated on load; `patchProject` even no-ops when no
// IDB row exists yet, so settings written only there are silently dropped on
// reload (the same class of bug that lost the Gemini key and the editor lens).
// localStorage is the durable, client-owned store these settings need — mirrors
// useEditorLensPreference / user-api-keys.
//
// Threat model matches user-api-keys: localStorage is readable by any script on
// this origin; we don't store anything here we wouldn't already keep in the
// (unencrypted) local project record.

import type { ProjectTtsSettings } from "@/lib/parsers/types"

const PREFIX = "frontier:project-tts:"

function storageKey(projectId: string): string {
  return PREFIX + projectId
}

export function loadProjectTts(projectId: string): ProjectTtsSettings | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return undefined
    return JSON.parse(raw) as ProjectTtsSettings
  } catch {
    return undefined
  }
}

export function saveProjectTts(projectId: string, settings: ProjectTtsSettings): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(storageKey(projectId), JSON.stringify(settings))
  } catch {
    /* quota / access denied — ignore; in-memory state still reflects the edit */
  }
}
