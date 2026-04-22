import { useState, useCallback } from "react"
import * as Y from "yjs"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { setPlainText } from "@/lib/richtext/translated-xml"
import type { ScoredPair } from "@/lib/search/dual-index"
import type { CellData } from "./useCells"
import { buildPrompt, complete, resolveProvider, DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { useFrontierHealth } from "@/lib/completion/frontier-health"
import { appendCellHistory } from "./useCellHistory"

// Default settings for projects that haven't customized anything yet.
// Frontier provider + default system prompt, no custom endpoint.
const FALLBACK_SETTINGS: CompletionSettings = {
  provider: "frontier",
  endpoint: "",
  model: "",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  llmHealthPenalty: 0.1,
}

export function useCompletion(
  doc: Y.Doc | null,
  settings: CompletionSettings | undefined,
  sourceLanguage: string,
  targetLanguage: string,
  search: (query: string, limit?: number) => ScoredPair[],
  session: FrontierSession | null = null,
) {
  const [completing, setCompleting] = useState<Map<string, string>>(new Map())
  const [examples, setExamples] = useState<Map<string, ScoredPair[]>>(new Map())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())

  // Missing settings means "Frontier default with in-memory fallback" — we
  // don't persist anything until the user customizes.
  const effectiveSettings = settings ?? FALLBACK_SETTINGS
  const provider = resolveProvider(effectiveSettings)
  const { available: frontierAvailable } = useFrontierHealth()

  // Frontier: needs a session AND the /api/v2/health probe must have returned
  // ok at least once. Custom: needs endpoint + model.
  const isConfigured = provider === "frontier"
    ? Boolean(session?.jwt) && frontierAvailable
    : Boolean(effectiveSettings.endpoint && effectiveSettings.model)

  const completeSingle = useCallback(async (cell: CellData) => {
    if (!doc || !isConfigured) return

    setCompleting((p) => new Map(p).set(cell.id, "searching"))
    const found = search(cell.original, 5)
    setExamples((p) => new Map(p).set(cell.id, found))
    setCompleting((p) => new Map(p).set(cell.id, "generating"))

    try {
      const messages = buildPrompt({
        sourceLanguage, targetLanguage,
        systemPrompt: effectiveSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        sourceText: cell.original,
        examples: found.map((e) => ({ source: e.source, target: e.target })),
      })
      const result = await complete({
        settings: effectiveSettings, session,
        messages,
        stream: true,
        onChunk: (text) => {
          const cells = doc.getMap("cells")
          const yCell = cells.get(cell.id) as Y.Map<unknown> | undefined
          if (yCell) {
            const frag = yCell.get("translatedXml") as Y.XmlFragment | undefined
            if (frag) {
              setPlainText(frag, text)
            } else {
              doc.transact(() => { yCell.set("translated", text) })
            }
          }
        },
      })
      appendCellHistory(doc, cell.id, {
        value: result, source: "llm", author: effectiveSettings.model || "frontier-default",
        validated: false, examples: found.map((e) => ({ cellId: e.cellId, weight: e.coverageWeight })),
      })
      setCompleting((p) => new Map(p).set(cell.id, "done"))
    } catch (err) {
      setCompleting((p) => new Map(p).set(cell.id, "error"))
      setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
    }
  }, [doc, effectiveSettings, isConfigured, sourceLanguage, targetLanguage, search, session])

  const completeBatch = useCallback(async (cells: CellData[]) => {
    if (!doc || !isConfigured) return

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
            systemPrompt: effectiveSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
            sourceText: cell.original,
            examples: found.map((e) => ({ source: e.source, target: e.target })),
          })
          const result = await complete({
            settings: effectiveSettings, session,
            messages,
          })
          appendCellHistory(doc!, cell.id, {
            value: result, source: "llm", author: effectiveSettings.model || "frontier-default",
            validated: false, examples: found.map((e) => ({ cellId: e.cellId, weight: e.coverageWeight })),
          })
          setCompleting((p) => new Map(p).set(cell.id, "done"))
        } catch (err) {
          setCompleting((p) => new Map(p).set(cell.id, "error"))
          setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
        }
      }
    }
    await Promise.all(Array.from({ length: 3 }, () => worker()))
  }, [doc, effectiveSettings, isConfigured, sourceLanguage, targetLanguage, search, session])

  return { completeSingle, completeBatch, isConfigured, completing, examples, errors }
}
