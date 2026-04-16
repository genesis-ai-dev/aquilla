import { useCallback, useEffect, useState } from "react"
import * as Y from "yjs"

const RTL_LANGS = new Set(["ar", "arc", "dv", "fa", "he", "khw", "ks", "ku", "ps", "sd", "ur", "yi"])

function detectDirection(lang: string | undefined): "ltr" | "rtl" {
  const code = (lang || "").toLowerCase().split(/[-_]/)[0]
  return RTL_LANGS.has(code) ? "rtl" : "ltr"
}

interface MetaSource {
  lineNumbersEnabled?: boolean
  textDirection?: "ltr" | "rtl"
  [key: string]: unknown
}

export interface FileMeta {
  lineNumbersEnabled: boolean
  textDirection: "ltr" | "rtl"
  setLineNumbersEnabled: (v: boolean) => void
  setTextDirection: (v: "ltr" | "rtl") => void
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

export function useFileMeta(doc: Y.Doc | null, targetLanguage: string | undefined): FileMeta {
  const [lineNumbersEnabled, setLineNumbersEnabledState] = useState(true)
  const [textDirection, setTextDirectionState] = useState<"ltr" | "rtl">("ltr")

  useEffect(() => {
    if (!doc) return
    const meta = doc.getMap("meta")

    function read() {
      const src = readSource(doc!)
      const ln = src?.lineNumbersEnabled
      setLineNumbersEnabledState(ln === undefined ? true : Boolean(ln))
      const td = src?.textDirection
      if (td === "ltr" || td === "rtl") {
        setTextDirectionState(td)
      } else {
        const detected = detectDirection(targetLanguage)
        setTextDirectionState(detected)
        // Seed only if the field was never set
        writeSource(doc!, { textDirection: detected })
      }
    }

    read()

    function onChange() { queueMicrotask(read) }
    meta.observeDeep(onChange)
    return () => { meta.unobserveDeep(onChange) }
  }, [doc, targetLanguage])

  const setLineNumbersEnabled = useCallback((v: boolean) => {
    if (!doc) return
    writeSource(doc, { lineNumbersEnabled: v })
  }, [doc])

  const setTextDirection = useCallback((v: "ltr" | "rtl") => {
    if (!doc) return
    writeSource(doc, { textDirection: v })
  }, [doc])

  return { lineNumbersEnabled, textDirection, setLineNumbersEnabled, setTextDirection }
}
