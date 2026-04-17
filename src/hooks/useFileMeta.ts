import { useCallback, useEffect, useState } from "react"
import * as Y from "yjs"

const RTL_LANGS = new Set(["ar", "arc", "dv", "fa", "he", "khw", "ks", "ku", "ps", "sd", "ur", "yi"])

function detectDirection(lang: string | undefined): "ltr" | "rtl" {
  const code = (lang || "").toLowerCase().split(/[-_]/)[0]
  return RTL_LANGS.has(code) ? "rtl" : "ltr"
}

interface MetaSource {
  lineNumbersEnabled?: boolean
  // Legacy: pre-split name. Still read/written as the TARGET direction for
  // backwards compat with existing Y.Docs that only had one direction.
  textDirection?: "ltr" | "rtl"
  sourceTextDirection?: "ltr" | "rtl"
  rtlHintDismissed?: boolean
  [key: string]: unknown
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

function readSource(doc: Y.Doc): MetaSource | undefined {
  return doc.getMap("meta").get("__source") as MetaSource | undefined
}

function writeSource(doc: Y.Doc, patch: Partial<MetaSource>): void {
  doc.transact(() => {
    const meta = doc.getMap("meta")
    const current = (meta.get("__source") as MetaSource | undefined) || {}
    meta.set("__source", { ...current, ...patch })
  })
}

export function useFileMeta(
  doc: Y.Doc | null,
  sourceLanguage: string | undefined,
  targetLanguage: string | undefined,
): FileMeta {
  const [lineNumbersEnabled, setLineNumbersEnabledState] = useState(true)
  const [sourceTextDirection, setSourceTextDirectionState] = useState<"ltr" | "rtl">("ltr")
  const [targetTextDirection, setTargetTextDirectionState] = useState<"ltr" | "rtl">("ltr")
  const [rtlHintDismissed, setRtlHintDismissedState] = useState(false)

  useEffect(() => {
    if (!doc) return
    const meta = doc.getMap("meta")

    function read() {
      const src = readSource(doc!)
      const ln = src?.lineNumbersEnabled
      setLineNumbersEnabledState(ln === undefined ? true : Boolean(ln))

      // Target direction: legacy textDirection field, fall back to detection.
      const td = src?.textDirection
      if (td === "ltr" || td === "rtl") {
        setTargetTextDirectionState(td)
      } else {
        const detected = detectDirection(targetLanguage)
        setTargetTextDirectionState(detected)
        writeSource(doc!, { textDirection: detected })
      }

      // Source direction: new field, seed from sourceLanguage detection.
      const sd = src?.sourceTextDirection
      if (sd === "ltr" || sd === "rtl") {
        setSourceTextDirectionState(sd)
      } else {
        const detected = detectDirection(sourceLanguage)
        setSourceTextDirectionState(detected)
        writeSource(doc!, { sourceTextDirection: detected })
      }

      // RTL hint dismissal flag — sticky per-file. Once the user acknowledges
      // the auto-detected direction, we don't pester them again.
      setRtlHintDismissedState(Boolean(src?.rtlHintDismissed))
    }

    read()

    function onChange() { queueMicrotask(read) }
    meta.observeDeep(onChange)
    return () => { meta.unobserveDeep(onChange) }
  }, [doc, sourceLanguage, targetLanguage])

  const setLineNumbersEnabled = useCallback((v: boolean) => {
    if (!doc) return
    writeSource(doc, { lineNumbersEnabled: v })
  }, [doc])

  const setSourceTextDirection = useCallback((v: "ltr" | "rtl") => {
    if (!doc) return
    writeSource(doc, { sourceTextDirection: v })
  }, [doc])

  const setTargetTextDirection = useCallback((v: "ltr" | "rtl") => {
    if (!doc) return
    writeSource(doc, { textDirection: v })
  }, [doc])

  const dismissRtlHint = useCallback(() => {
    if (!doc) return
    writeSource(doc, { rtlHintDismissed: true })
  }, [doc])

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
