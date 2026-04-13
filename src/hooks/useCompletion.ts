import { useState, useCallback } from "react"
import * as Y from "yjs"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { ScoredPair } from "@/lib/search/search-index"
import type { CellData } from "./useCells"
import { buildPrompt, complete, DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { appendCellHistory } from "./useCellHistory"

export function useCompletion(
  doc: Y.Doc | null,
  settings: CompletionSettings | undefined,
  sourceLanguage: string,
  targetLanguage: string,
  search: (query: string, limit?: number) => ScoredPair[]
) {
  const [completing, setCompleting] = useState<Map<string, string>>(new Map())
  const [examples, setExamples] = useState<Map<string, ScoredPair[]>>(new Map())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())

  const isConfigured = Boolean(settings?.endpoint && settings?.model)

  const completeSingle = useCallback(async (cell: CellData) => {
    if (!doc || !settings || !isConfigured) return

    setCompleting((p) => new Map(p).set(cell.id, "searching"))
    const found = search(cell.original, 5)
    setExamples((p) => new Map(p).set(cell.id, found))
    setCompleting((p) => new Map(p).set(cell.id, "generating"))

    try {
      const messages = buildPrompt({
        sourceLanguage, targetLanguage,
        systemPrompt: settings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        sourceText: cell.original,
        examples: found.map((e) => ({ source: e.source, target: e.target })),
      })
      const result = await complete({
        endpoint: settings.endpoint, model: settings.model,
        messages, maxTokens: settings.maxTokens, temperature: settings.temperature,
        stream: true,
        onChunk: (text) => {
          const cells = doc.getMap("cells")
          const yCell = cells.get(cell.id) as Y.Map<unknown> | undefined
          if (yCell) doc.transact(() => { yCell.set("translated", text) })
        },
      })
      appendCellHistory(doc, cell.id, {
        value: result, source: "llm", author: settings.model,
        validated: false, examples: found.map((e) => e.cellId),
      })
      setCompleting((p) => new Map(p).set(cell.id, "done"))
    } catch (err) {
      setCompleting((p) => new Map(p).set(cell.id, "error"))
      setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
    }
  }, [doc, settings, isConfigured, sourceLanguage, targetLanguage, search])

  const completeBatch = useCallback(async (cells: CellData[]) => {
    if (!doc || !settings || !isConfigured) return

    const allExamples = new Map<string, ScoredPair[]>()
    for (const cell of cells) {
      setCompleting((p) => new Map(p).set(cell.id, "searching"))
      allExamples.set(cell.id, search(cell.original, 5))
    }
    for (const cell of cells) {
      setExamples((p) => new Map(p).set(cell.id, allExamples.get(cell.id) || []))
      setCompleting((p) => new Map(p).set(cell.id, "generating"))
    }

    const queue = [...cells]
    async function worker() {
      while (queue.length > 0) {
        const cell = queue.shift()!
        const found = allExamples.get(cell.id) || []
        try {
          const messages = buildPrompt({
            sourceLanguage, targetLanguage,
            systemPrompt: settings!.systemPrompt || DEFAULT_SYSTEM_PROMPT,
            sourceText: cell.original,
            examples: found.map((e) => ({ source: e.source, target: e.target })),
          })
          const result = await complete({
            endpoint: settings!.endpoint, model: settings!.model,
            messages, maxTokens: settings!.maxTokens, temperature: settings!.temperature,
          })
          appendCellHistory(doc!, cell.id, {
            value: result, source: "llm", author: settings!.model,
            validated: false, examples: found.map((e) => e.cellId),
          })
          setCompleting((p) => new Map(p).set(cell.id, "done"))
        } catch (err) {
          setCompleting((p) => new Map(p).set(cell.id, "error"))
          setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
        }
      }
    }
    await Promise.all(Array.from({ length: 3 }, () => worker()))
  }, [doc, settings, isConfigured, sourceLanguage, targetLanguage, search])

  return { completeSingle, completeBatch, isConfigured, completing, examples, errors }
}
