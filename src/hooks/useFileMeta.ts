import { useCallback, useEffect, useState } from "react"
import * as Y from "yjs"
import { getPlainText } from "@/lib/richtext/translated-xml"

const RTL_LANGS = new Set(["ar", "arc", "dv", "fa", "ha", "he", "khw", "ks", "ku", "ps", "sd", "ur", "yi"])

// Strongly-directional Unicode ranges. RTL covers Hebrew, Arabic, Syriac,
// Thaana, N'Ko, Samaritan, Mandaic, Arabic presentation forms. LTR covers
// basic/extended Latin, Greek, Cyrillic — representative of the scripts we
// commonly encounter.
const RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF\u07C0-\u07FF\u0800-\u083F\u0840-\u085F\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/
const LTR_RE = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/

function detectDirectionFromLang(lang: string | undefined): "ltr" | "rtl" {
  const code = (lang || "").toLowerCase().split(/[-_]/)[0]
  return RTL_LANGS.has(code) ? "rtl" : "ltr"
}

/**
 * Content-based direction detection. Counts strongly-directional chars in
 * the sample. Returns null when the sample contains no directional chars
 * (empty, or only digits/punctuation/whitespace).
 */
export function detectDirectionFromText(text: string): "ltr" | "rtl" | null {
  if (!text) return null
  let rtl = 0
  let ltr = 0
  for (const ch of text) {
    if (RTL_RE.test(ch)) rtl++
    else if (LTR_RE.test(ch)) ltr++
  }
  if (rtl === 0 && ltr === 0) return null
  return rtl > ltr ? "rtl" : "ltr"
}

const SAMPLE_CELL_COUNT = 10

function sampleCellText(doc: Y.Doc, side: "source" | "target"): string {
  const cellsMap = doc.getMap("cells")
  const order = doc.getArray<string>("order").toArray().slice(0, SAMPLE_CELL_COUNT)
  const parts: string[] = []
  for (const id of order) {
    const cell = cellsMap.get(id) as Y.Map<unknown> | undefined
    if (!cell) continue
    if (side === "source") {
      const orig = cell.get("original") as string | undefined
      if (orig) parts.push(orig)
    } else {
      const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
      const trans = frag ? getPlainText(frag) : (cell.get("translated") as string | undefined) || ""
      if (trans) parts.push(trans)
    }
  }
  return parts.join(" ")
}

/**
 * Combined detection. Language-code hint wins when it maps to an RTL
 * language (a deliberate signal). Otherwise sample actual cell content —
 * which catches the common case where sourceLanguage is "eng" or "hebrew"
 * or blank while the content is clearly RTL.
 */
function detectSideDirection(
  doc: Y.Doc,
  side: "source" | "target",
  langCode: string | undefined,
): "ltr" | "rtl" {
  const langDir = detectDirectionFromLang(langCode)
  if (langDir === "rtl") return "rtl"
  const sample = sampleCellText(doc, side)
  const contentDir = detectDirectionFromText(sample)
  return contentDir ?? langDir
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

      // Target direction: legacy textDirection field wins when set. Otherwise
      // run combined detection (lang hint + content-character majority).
      const td = src?.textDirection
      if (td === "ltr" || td === "rtl") {
        setTargetTextDirectionState(td)
      } else {
        const detected = detectSideDirection(doc!, "target", targetLanguage)
        setTargetTextDirectionState(detected)
        writeSource(doc!, { textDirection: detected })
      }

      // Source direction: new field; same combined detection.
      const sd = src?.sourceTextDirection
      if (sd === "ltr" || sd === "rtl") {
        setSourceTextDirectionState(sd)
      } else {
        const detected = detectSideDirection(doc!, "source", sourceLanguage)
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
