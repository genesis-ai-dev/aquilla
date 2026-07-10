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

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  type DirectionMode,
  type TextDirection,
  languageDefaultDirection,
  resolveDefaultDirection,
} from "@/lib/text-direction"

export interface FileMeta {
  lineNumbersEnabled: boolean
  sourceDirectionMode: DirectionMode
  targetDirectionMode: DirectionMode
  sourceTextDirection: TextDirection
  targetTextDirection: TextDirection
  rtlHintDismissed: boolean
  setLineNumbersEnabled: (v: boolean) => void
  setSourceDirectionMode: (v: DirectionMode) => void
  setTargetDirectionMode: (v: DirectionMode) => void
  setSourceTextDirection: (v: TextDirection) => void
  setTargetTextDirection: (v: TextDirection) => void
  dismissRtlHint: () => void
}

interface FileMetaState {
  key: string
  lineNumbersEnabled: boolean
  sourceDirectionMode: DirectionMode
  targetDirectionMode: DirectionMode
  rtlHintDismissed: boolean
  rtlHintSignature: string | null
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

function readKey(fileId: string | null, key: string): string | null {
  if (!fileId || typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(storageKey(fileId, key))
  } catch {
    return null
  }
}

function readMode(
  fileId: string | null,
  modeKey: string,
  legacyDirKey: string,
): DirectionMode {
  const mode = readKey(fileId, modeKey)
  if (mode === "auto" || mode === "ltr" || mode === "rtl") return mode
  const legacy = readKey(fileId, legacyDirKey)
  if (legacy === "ltr" || legacy === "rtl") return legacy
  return "auto"
}

function writeKey(fileId: string | null, key: string, value: string): void {
  if (!fileId || typeof window === "undefined") return
  try {
    window.localStorage.setItem(storageKey(fileId, key), value)
  } catch {
    /* quota / disabled storage — UI works against in-memory state */
  }
}

function removeKey(fileId: string | null, key: string): void {
  if (!fileId || typeof window === "undefined") return
  try {
    window.localStorage.removeItem(storageKey(fileId, key))
  } catch {
    /* quota / disabled storage — UI works against in-memory state */
  }
}

function metaKey(
  fileId: string | null,
  sourceLanguage: string | undefined,
  targetLanguage: string | undefined,
  sourceDirectionHint?: TextDirection,
  targetDirectionHint?: TextDirection,
): string {
  return `${fileId ?? "no-file"}:${sourceLanguage ?? ""}:${targetLanguage ?? ""}:${sourceDirectionHint ?? ""}:${targetDirectionHint ?? ""}`
}

function buildRtlHintSignature(
  sourceMode: DirectionMode,
  targetMode: DirectionMode,
  sourceDefault: TextDirection,
  targetDefault: TextDirection,
): string | null {
  const parts: string[] = []
  if (sourceMode === "auto" && sourceDefault === "rtl") parts.push("source:rtl")
  if (targetMode === "auto" && targetDefault === "rtl") parts.push("target:rtl")
  return parts.length > 0 ? parts.join("|") : null
}

function readHintDismissed(fileId: string | null, signature: string | null): boolean {
  if (!signature) return true
  if (readBool(fileId, "rtlHint", false)) return true
  return readKey(fileId, "rtlHintSignature") === signature
}

function readFileMetaState(
  fileId: string | null,
  sourceLanguage: string | undefined,
  targetLanguage: string | undefined,
  sourceDirectionHint?: TextDirection,
  targetDirectionHint?: TextDirection,
): FileMetaState {
  const sourceDirectionMode = readMode(fileId, "sourceDirectionMode", "sourceDir")
  const targetDirectionMode = readMode(fileId, "targetDirectionMode", "targetDir")
  const sourceDefault = sourceDirectionHint ?? languageDefaultDirection(sourceLanguage)
  const targetDefault = targetDirectionHint ?? languageDefaultDirection(targetLanguage)
  const rtlHintSignature = buildRtlHintSignature(
    sourceDirectionMode,
    targetDirectionMode,
    sourceDefault,
    targetDefault,
  )
  return {
    key: metaKey(fileId, sourceLanguage, targetLanguage, sourceDirectionHint, targetDirectionHint),
    lineNumbersEnabled: readBool(fileId, "lineNumbers", true),
    sourceDirectionMode,
    targetDirectionMode,
    rtlHintDismissed: readHintDismissed(fileId, rtlHintSignature),
    rtlHintSignature,
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
  directionHints: { sourceTextDirection?: TextDirection | null; targetTextDirection?: TextDirection | null } = {},
): FileMeta {
  const fileId = typeof fileIdOrDoc === "string" ? fileIdOrDoc : null
  const currentKey = metaKey(
    fileId,
    sourceLanguage,
    targetLanguage,
    directionHints.sourceTextDirection ?? undefined,
    directionHints.targetTextDirection ?? undefined,
  )
  const baseline = useMemo(
    () => readFileMetaState(
      fileId,
      sourceLanguage,
      targetLanguage,
      directionHints.sourceTextDirection ?? undefined,
      directionHints.targetTextDirection ?? undefined,
    ),
    [fileId, sourceLanguage, targetLanguage, directionHints.sourceTextDirection, directionHints.targetTextDirection],
  )

  const [metaState, setMetaState] = useState<FileMetaState>(baseline)

  useEffect(() => {
    setMetaState(baseline)
  }, [baseline])

  const effectiveState = metaState.key === currentKey ? metaState : baseline
  const sourceTextDirection = resolveDefaultDirection(
    effectiveState.sourceDirectionMode,
    directionHints.sourceTextDirection ?? languageDefaultDirection(sourceLanguage),
  )
  const targetTextDirection = resolveDefaultDirection(
    effectiveState.targetDirectionMode,
    directionHints.targetTextDirection ?? languageDefaultDirection(targetLanguage),
  )

  const withCurrentState = useCallback((updater: (base: FileMetaState) => FileMetaState) => {
    setMetaState((prev) => updater(prev.key === currentKey
      ? prev
      : readFileMetaState(
        fileId,
        sourceLanguage,
        targetLanguage,
        directionHints.sourceTextDirection ?? undefined,
        directionHints.targetTextDirection ?? undefined,
      )))
  }, [currentKey, fileId, sourceLanguage, targetLanguage, directionHints.sourceTextDirection, directionHints.targetTextDirection])

  const setLineNumbersEnabled = useCallback((v: boolean) => {
    withCurrentState((base) => ({ ...base, lineNumbersEnabled: v }))
    writeKey(fileId, "lineNumbers", v ? "1" : "0")
  }, [fileId, withCurrentState])

  const setSourceDirectionMode = useCallback((v: DirectionMode) => {
    writeKey(fileId, "sourceDirectionMode", v)
    if (v === "auto") removeKey(fileId, "sourceDir")
    else writeKey(fileId, "sourceDir", v)
    withCurrentState((base) => {
      const sourceDefault = directionHints.sourceTextDirection ?? languageDefaultDirection(sourceLanguage)
      const targetDefault = directionHints.targetTextDirection ?? languageDefaultDirection(targetLanguage)
      const rtlHintSignature = buildRtlHintSignature(
        v,
        base.targetDirectionMode,
        sourceDefault,
        targetDefault,
      )
      return {
        ...base,
        sourceDirectionMode: v,
        rtlHintSignature,
        rtlHintDismissed: readHintDismissed(fileId, rtlHintSignature),
      }
    })
  }, [directionHints.sourceTextDirection, directionHints.targetTextDirection, fileId, sourceLanguage, targetLanguage, withCurrentState])

  const setTargetDirectionMode = useCallback((v: DirectionMode) => {
    writeKey(fileId, "targetDirectionMode", v)
    if (v === "auto") removeKey(fileId, "targetDir")
    else writeKey(fileId, "targetDir", v)
    withCurrentState((base) => {
      const sourceDefault = directionHints.sourceTextDirection ?? languageDefaultDirection(sourceLanguage)
      const targetDefault = directionHints.targetTextDirection ?? languageDefaultDirection(targetLanguage)
      const rtlHintSignature = buildRtlHintSignature(
        base.sourceDirectionMode,
        v,
        sourceDefault,
        targetDefault,
      )
      return {
        ...base,
        targetDirectionMode: v,
        rtlHintSignature,
        rtlHintDismissed: readHintDismissed(fileId, rtlHintSignature),
      }
    })
  }, [directionHints.sourceTextDirection, directionHints.targetTextDirection, fileId, sourceLanguage, targetLanguage, withCurrentState])

  const dismissRtlHint = useCallback(() => {
    withCurrentState((base) => ({ ...base, rtlHintDismissed: true }))
    if (effectiveState.rtlHintSignature) {
      writeKey(fileId, "rtlHintSignature", effectiveState.rtlHintSignature)
    }
  }, [effectiveState.rtlHintSignature, fileId, withCurrentState])

  const setSourceTextDirection = useCallback((v: TextDirection) => {
    setSourceDirectionMode(v)
  }, [setSourceDirectionMode])

  const setTargetTextDirection = useCallback((v: TextDirection) => {
    setTargetDirectionMode(v)
  }, [setTargetDirectionMode])

  return {
    lineNumbersEnabled: effectiveState.lineNumbersEnabled,
    sourceDirectionMode: effectiveState.sourceDirectionMode,
    targetDirectionMode: effectiveState.targetDirectionMode,
    sourceTextDirection,
    targetTextDirection,
    rtlHintDismissed: effectiveState.rtlHintDismissed,
    setLineNumbersEnabled,
    setSourceDirectionMode,
    setTargetDirectionMode,
    setSourceTextDirection,
    setTargetTextDirection,
    dismissRtlHint,
  }
}
