import { useCallback, useEffect, useState } from "react"

export type TargetKeyTermHighlightMode = "always" | "focused" | "never"

const STORAGE_KEY = "aquilla:targetKeyTermHighlights:"

function normalizeMode(raw: string | null): TargetKeyTermHighlightMode {
  if (raw === "always" || raw === "focused" || raw === "never") return raw
  return "never"
}

function readPreference(projectId: string): TargetKeyTermHighlightMode {
  try {
    return normalizeMode(localStorage.getItem(STORAGE_KEY + projectId))
  } catch {
    return "never"
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
