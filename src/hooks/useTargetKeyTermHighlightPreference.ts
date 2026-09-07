import { useCallback, useEffect, useState } from "react"

export type TargetKeyTermHighlightMode = "always" | "focused" | "never"

const STORAGE_KEY = "aquilla:targetKeyTermHighlights:"

/**
 * The default is "focused" (AQU-1006 follow-up), not "never".
 *
 * It was "never", and that is why approved key terms appeared to be broken in
 * production on 2026-09-04 while working locally: this preference is stored
 * per project in localStorage, so the person demoing had flipped it on months
 * earlier and every attendee got the silent default. A termbase you cannot see
 * being enforced reads as a termbase that is not working.
 *
 * "focused" rather than "always" so the highlight follows the row being edited
 * instead of painting the whole file at once.
 */
function normalizeMode(raw: string | null): TargetKeyTermHighlightMode {
  if (raw === "always" || raw === "focused" || raw === "never") return raw
  return "focused"
}

function readPreference(projectId: string): TargetKeyTermHighlightMode {
  try {
    return normalizeMode(localStorage.getItem(STORAGE_KEY + projectId))
  } catch {
    // Storage unavailable (private window, blocked cookies) — same default as
    // an unset preference, never a quieter one.
    return "focused"
  }
}

/** Per-project preference for approved key-term highlights in target cells. */
export function useTargetKeyTermHighlightPreference(
  projectId: string,
): [TargetKeyTermHighlightMode, (mode: TargetKeyTermHighlightMode) => void] {
  const [mode, setMode] = useState<TargetKeyTermHighlightMode>(() => readPreference(projectId))

  useEffect(() => {
    setMode(readPreference(projectId))
  }, [projectId])

  const setAndPersist = useCallback((nextMode: TargetKeyTermHighlightMode) => {
    setMode(nextMode)
    try {
      localStorage.setItem(STORAGE_KEY + projectId, nextMode)
    } catch { /* storage unavailable */ }
  }, [projectId])

  return [mode, setAndPersist]
}
