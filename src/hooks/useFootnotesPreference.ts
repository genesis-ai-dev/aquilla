import { useState, useEffect, useCallback } from "react"
import type { FootnoteViewMode } from "@/lib/footnotes/types"

const STORAGE_KEY = "codex:showFootnotesInline:"

function normalizeMode(raw: string | null): FootnoteViewMode {
  if (raw === "inline" || raw === "tray" || raw === "off") return raw
  if (raw === "true") return "inline"
  return "off"
}

function readPreference(projectId: string): FootnoteViewMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + projectId)
    return normalizeMode(raw)
  } catch {
    return "off"
  }
}

/** Per-project preference: footnote display mode. Default OFF. */
export function useFootnotesPreference(projectId: string): [FootnoteViewMode, (v: FootnoteViewMode) => void] {
  const [mode, setMode] = useState<FootnoteViewMode>(() => readPreference(projectId))

  useEffect(() => {
    setMode(readPreference(projectId))
  }, [projectId])

  const setAndPersist = useCallback((v: FootnoteViewMode) => {
    setMode(v)
    try {
      localStorage.setItem(STORAGE_KEY + projectId, v)
    } catch { /* storage unavailable */ }
  }, [projectId])

  return [mode, setAndPersist]
}
