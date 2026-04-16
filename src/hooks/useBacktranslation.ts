import { useCallback, useState } from "react"
import * as Y from "yjs"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CellData } from "./useCells"
import { generateBacktranslation } from "@/lib/completion/backtranslation-service"
import { resolveProvider } from "@/lib/completion/completion-service"
import { setCellBacktranslation } from "./useCellHistory"

type FindExamples = (cell: CellData) => { target: string; backtranslation: string }[]

export function useBacktranslation(
  doc: Y.Doc | null,
  settings: CompletionSettings | undefined,
  sourceLanguage: string,
  targetLanguage: string,
  findExamples: FindExamples,
  session: FrontierSession | null = null,
) {
  const [generating, setGenerating] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())

  const isConfigured = settings
    ? resolveProvider(settings) === "frontier"
      ? Boolean(session?.jwt)
      : Boolean(settings.endpoint && settings.model)
    : false

  const generate = useCallback(async (cell: CellData) => {
    if (!doc || !settings || !isConfigured) return
    const targetText = cell.translated.trim()
    if (!targetText) return

    setGenerating((p) => new Set(p).add(cell.id))
    setErrors((p) => { const n = new Map(p); n.delete(cell.id); return n })

    try {
      const examples = findExamples(cell)
      setCellBacktranslation(doc, cell.id, "", targetText)

      const result = await generateBacktranslation({
        sourceLanguage,
        targetLanguage,
        targetText,
        examples,
        settings,
        session,
        onChunk: (text) => {
          setCellBacktranslation(doc, cell.id, text, targetText)
        },
      })

      setCellBacktranslation(doc, cell.id, result, targetText)
    } catch (err) {
      setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
    } finally {
      setGenerating((p) => { const n = new Set(p); n.delete(cell.id); return n })
    }
  }, [doc, settings, isConfigured, sourceLanguage, targetLanguage, findExamples, session])

  return { generate, generating, errors, isConfigured }
}
