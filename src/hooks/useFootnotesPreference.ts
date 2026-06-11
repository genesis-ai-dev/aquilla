import { useState, useEffect, useCallback } from "react"

const STORAGE_KEY = "codex:showFootnotesInline:"

function readPreference(projectId: string): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + projectId)
    return raw === "true"  // default OFF
  } catch {
    return false
  }
}

/** Per-project preference: show footnotes inline below each cell. Default OFF. */
export function useFootnotesPreference(projectId: string): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => readPreference(projectId))

  useEffect(() => {
    setEnabled(readPreference(projectId))
  }, [projectId])

  const setAndPersist = useCallback((v: boolean) => {
    setEnabled(v)
    try {
      localStorage.setItem(STORAGE_KEY + projectId, String(v))
    } catch { /* storage unavailable */ }
  }, [projectId])

  return [enabled, setAndPersist]
}
