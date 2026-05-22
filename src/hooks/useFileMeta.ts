// Phase 2b: per-file UI preferences (line numbers, text direction overrides,
// RTL hint dismissal) move off Y.Doc onto localStorage. The synced
// "language" inputs come from useProject / useProjectSettings — they're
// already identity-backed.
//
// Storing UI prefs locally is the correct call for v1: AD-3 v1 thin client
// has no per-user-pref sync path (Q18 in the spec is still tentative),
// these prefs are per-device anyway (RTL hint = "I dismissed this here"),
// and the legacy Y.Doc-based storage tied them to project-wide sync which
// surprised collaborators (one editor toggled line numbers → other peers'
// editors switched too). LocalStorage scoped to (fileId, key) gives the
// expected per-device behavior.

import { useCallback, useEffect, useState } from "react"

const RTL_LANGS = new Set(["ar", "arc", "dv", "fa", "he", "khw", "ks", "ku", "ps", "sd", "ur", "yi"])

function detectDirection(lang: string | undefined): "ltr" | "rtl" {
  const code = (lang || "").toLowerCase().split(/[-_]/)[0]
  return RTL_LANGS.has(code) ? "rtl" : "ltr"
}

export interface FileMeta {
  lineNumbersEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  rtlHintDismissed: boolean
  setLineNumbersEnabled: (v: boolean) => void
  setSourceTextDirection: (v: "ltr" | "rtl") => void
  setTargetTextDirection: (v: "ltr" | "rtl") => void
  dismissRtlHint: () => void
}

function storageKey(fileId: string, key: string): string {
  return `codex:file-meta:${fileId}:${key}`
}

function readBool(fileId: string | null, key: string, fallback: boolean): boolean {
  if (!fileId || typeof window === "undefined") return fallback
  try {
    const v = window.localStorage.getItem(storageKey(fileId, key))
    if (v === null) return fallback
    return v === "1"
  } catch {
    return fallback
  }
}

function readDir(
  fileId: string | null,
  key: string,
  fallback: "ltr" | "rtl",
): "ltr" | "rtl" {
  if (!fileId || typeof window === "undefined") return fallback
  try {
    const v = window.localStorage.getItem(storageKey(fileId, key))
    if (v === "ltr" || v === "rtl") return v
    return fallback
  } catch {
    return fallback
  }
}

function writeKey(fileId: string | null, key: string, value: string): void {
  if (!fileId || typeof window === "undefined") return
  try {
    window.localStorage.setItem(storageKey(fileId, key), value)
  } catch {
    /* quota / disabled storage — UI works against in-memory state */
  }
}

/**
 * @param fileIdOrDoc — Phase 2b accepts the fileId string (preferred) but
 *   also tolerates `null` (no file open). The pre-Phase 2b signature took a
 *   Y.Doc here; callers passing the doc still resolve to a no-op surface
 *   since we ignore it.
 */
export function useFileMeta(
  fileIdOrDoc: string | null | unknown,
  sourceLanguage: string | undefined,
  targetLanguage: string | undefined,
): FileMeta {
  const fileId = typeof fileIdOrDoc === "string" ? fileIdOrDoc : null

  const [lineNumbersEnabled, setLineNumbersEnabledState] = useState(true)
  const [sourceTextDirection, setSourceTextDirectionState] = useState<"ltr" | "rtl">("ltr")
  const [targetTextDirection, setTargetTextDirectionState] = useState<"ltr" | "rtl">("ltr")
  const [rtlHintDismissed, setRtlHintDismissedState] = useState(false)

  useEffect(() => {
    setLineNumbersEnabledState(readBool(fileId, "lineNumbers", true))
    setTargetTextDirectionState(
      readDir(fileId, "targetDir", detectDirection(targetLanguage)),
    )
    setSourceTextDirectionState(
      readDir(fileId, "sourceDir", detectDirection(sourceLanguage)),
    )
    setRtlHintDismissedState(readBool(fileId, "rtlHint", false))
  }, [fileId, sourceLanguage, targetLanguage])

  const setLineNumbersEnabled = useCallback((v: boolean) => {
    setLineNumbersEnabledState(v)
    writeKey(fileId, "lineNumbers", v ? "1" : "0")
  }, [fileId])

  const setSourceTextDirection = useCallback((v: "ltr" | "rtl") => {
    setSourceTextDirectionState(v)
    writeKey(fileId, "sourceDir", v)
  }, [fileId])

  const setTargetTextDirection = useCallback((v: "ltr" | "rtl") => {
    setTargetTextDirectionState(v)
    writeKey(fileId, "targetDir", v)
  }, [fileId])

  const dismissRtlHint = useCallback(() => {
    setRtlHintDismissedState(true)
    writeKey(fileId, "rtlHint", "1")
  }, [fileId])

  return {
    lineNumbersEnabled,
    sourceTextDirection,
    targetTextDirection,
    rtlHintDismissed,
    setLineNumbersEnabled,
    setSourceTextDirection,
    setTargetTextDirection,
    dismissRtlHint,
  }
}
