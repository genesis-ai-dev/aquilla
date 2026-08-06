import { useCallback, useEffect, useState } from "react"

const STORAGE_PREFIX = "aquilla:translateAsRead:"

export const translateAsReadStorageKey = (projectId: string): string =>
  `${STORAGE_PREFIX}${projectId}`

function readPreference(projectId: string | undefined): boolean {
  if (!projectId || typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(translateAsReadStorageKey(projectId)) === "true"
  } catch {
    return false
  }
}

/** Device-local, per-project preference for viewport-triggered translation. */
export function useTranslateAsReadPreference(
  projectId: string | undefined,
): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState(() => readPreference(projectId))

  useEffect(() => {
    setEnabledState(readPreference(projectId))
  }, [projectId])

  const setEnabled = useCallback((next: boolean) => {
    if (projectId) {
      try {
        window.localStorage.setItem(translateAsReadStorageKey(projectId), String(next))
      } catch {
        // The mode still works for this session when storage is unavailable.
      }
    }
    setEnabledState(next)
  }, [projectId])

  return [enabled, setEnabled]
}
