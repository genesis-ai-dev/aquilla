import { useState, useEffect, useCallback } from "react"

const STORAGE_KEY = "codex:cellLabelsEnabled:"

function readPreference(projectId: string): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + projectId)
    return raw === null ? true : raw === "true"
  } catch {
    return true
  }
}

export function useCellLabelsPreference(projectId: string): [boolean, (v: boolean) => void] {
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
