import { useState, useCallback } from "react"
import * as Y from "yjs"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { setPlainText } from "@/lib/richtext/translated-xml"
import type { ScoredPair } from "@/lib/search/dual-index"

type SearchFn = (query: string, limit?: number, excludeId?: string) => ScoredPair[]
import type { CellData } from "./useCells"
import { buildPrompt, buildBatchPrompt, complete, resolveProvider, DEFAULT_SYSTEM_PROMPT, type PassageExample } from "@/lib/completion/completion-service"
import type { PassageHit } from "./useSearchIndex"
import { useFrontierHealth } from "@/lib/completion/frontier-health"
import { appendCellHistory, dropLlmSeedHistory, recordHistoryEntry } from "./useCellHistory"
import posthog from "@/lib/posthog"

// Cap per LLM call. Above this we split sequentially and chain via priorBatch.
// Tuned for typical context windows; revisit if real selections start brushing
// up against model limits.
const MAX_CELLS_PER_CALL = 30

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

type CommitCompletedCell = (cell: CellData, text: string, author: string) => Promise<void>

export function useCompletion(
  doc: Y.Doc | null,
  settings: CompletionSettings | undefined,
  sourceLanguage: string,
  targetLanguage: string,
  search: SearchFn,
  searchPassages: (query: string, hits?: number, radius?: number) => PassageHit[],
  session: FrontierSession | null = null,
  commitCompletedCell?: CommitCompletedCell,
) {
  const [completing, setCompleting] = useState<Map<string, string>>(new Map())
  const [examples, setExamples] = useState<Map<string, ScoredPair[]>>(new Map())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())

  // Missing settings means "Frontier default with in-memory fallback" — we
  // don't persist anything until the user customizes.
  const effectiveSettings = settings ?? FALLBACK_SETTINGS
  const provider = resolveProvider(effectiveSettings)
  const { available: frontierAvailable } = useFrontierHealth()

  // "Configured" = the user has done the setup. Frontier: signed in.
  // Custom: endpoint + model. Service reachability (`isAvailable` below) is
  // a separate, runtime concern — folding it in here causes the AI setup
  // dialog to re-prompt every time the health probe fails, even though the
  // user already configured a provider.
  const isConfigured = provider === "frontier"
    ? Boolean(session?.jwt)
    : Boolean(effectiveSettings.endpoint && effectiveSettings.model)

  // "Available" = service is reachable right now. Used to disable Generate
  // with a clear "service unavailable" message — never to gate setup.
  const isAvailable = provider === "frontier" ? frontierAvailable : true

  const completeSingle = useCallback(async (cell: CellData) => {
    if (!doc || !isConfigured || !isAvailable) return

    setCompleting((p) => new Map(p).set(cell.id, "searching"))
    // Exclude the cell itself — re-completing an already-translated cell would
    // otherwise show the model its own (source, target) pair and get an echo.
    const found = search(cell.original, 5, cell.id)
    setExamples((p) => new Map(p).set(cell.id, found))
    setCompleting((p) => new Map(p).set(cell.id, "generating"))

    const llmAuthor = effectiveSettings.model || "frontier-default"
    // Seed an LLM history entry with validated:false BEFORE the stream starts.
    // Without this, deriveStatus's "translated text + empty history → validated"
    // fallback flips the cell to a green/validated state for the entire
    // streaming window, which the user sees as "auto-validated by the LLM."
    // The seed is collapsed into the final history entry below.
    dropLlmSeedHistory(doc, cell.id, llmAuthor)
    recordHistoryEntry(doc, cell.id, {
      value: "", source: "llm", author: llmAuthor, validated: false,
      examples: found.map((e) => ({ cellId: e.cellId, weight: e.coverageWeight })),
    })

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
      await commitCompletedCell?.(cell, result, llmAuthor)
      // Collapse the start-of-stream seed into the final entry.
      dropLlmSeedHistory(doc, cell.id, llmAuthor)
      appendCellHistory(doc, cell.id, {
        value: result, source: "llm", author: llmAuthor,
        validated: false, examples: found.map((e) => ({ cellId: e.cellId, weight: e.coverageWeight })),
      })
      posthog.capture("ai translation completed", {
        provider,
        model: effectiveSettings.model || "frontier-default",
        source_language: sourceLanguage,
        target_language: targetLanguage,
        example_count: found.length,
      })
      setCompleting((p) => new Map(p).set(cell.id, "done"))
    } catch (err) {
      // Stream failed — drop the seed so the cell isn't left with a phantom
      // empty LLM entry in its history.
      dropLlmSeedHistory(doc, cell.id, llmAuthor)
      posthog.captureException(err instanceof Error ? err : new Error(String(err)))
      setCompleting((p) => new Map(p).set(cell.id, "error"))
      setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
    }
  }, [doc, effectiveSettings, isConfigured, isAvailable, sourceLanguage, targetLanguage, search, session, provider, commitCompletedCell])

  // Segmented batch translation: each sub-batch goes out as one <vN>-framed
  // prompt and the response is demuxed back to cells. LLMs translate a passage
  // substantially better than the same verses in isolation, so we accept the
  // alignment risk in exchange for cross-verse context. Cells whose tag is
  // missing/malformed in the response fall through to single-cell completion;
  // the batch as a whole does not fail.
  const completeBatch = useCallback(async (cells: CellData[]) => {
    if (!doc || !isConfigured || !isAvailable) return

    const chunks: CellData[][] = []
    for (let i = 0; i < cells.length; i += MAX_CELLS_PER_CALL) {
      chunks.push(cells.slice(i, i + MAX_CELLS_PER_CALL))
    }

    posthog.capture("ai batch translation started", {
      provider,
      model: effectiveSettings.model || "frontier-default",
      source_language: sourceLanguage,
      target_language: targetLanguage,
      cell_count: cells.length,
      chunk_count: chunks.length,
      max_cells_per_call: MAX_CELLS_PER_CALL,
    })

    const writeCell = (cellId: string, text: string) => {
      const yCells = doc.getMap("cells")
      const yCell = yCells.get(cellId) as Y.Map<unknown> | undefined
      if (!yCell) return
      const frag = yCell.get("translatedXml") as Y.XmlFragment | undefined
      if (frag) setPlainText(frag, text)
      else doc.transact(() => { yCell.set("translated", text) })
    }

    let priorBatch: { source: string; target: string }[] = []
    const fallbackQueue: CellData[] = []

    for (const chunk of chunks) {
      // 1. Retrieve passage examples once for the whole sub-batch. Branching
      //    search is built for long queries — concatenating is the right call.
      for (const c of chunk) setCompleting((p) => new Map(p).set(c.id, "searching"))
      const concatenated = chunk.map((c) => c.original).join(" ")
      const passages = searchPassages(concatenated, 3, 2)
      const flatExamples: ScoredPair[] = passages.flatMap((p) =>
        p.cells.filter((c) => c.hit).map((c) => ({
          cellId: c.cellId, fileId: p.fileId, source: c.source, target: c.target,
          score: 1, matchedTokens: [], coverageWeight: 1,
        }))
      )
      const llmAuthor = effectiveSettings.model || "frontier-default"
      for (const c of chunk) {
        setExamples((p) => new Map(p).set(c.id, flatExamples))
        setCompleting((p) => new Map(p).set(c.id, "generating"))
        // Seed an LLM history entry with validated:false BEFORE streaming
        // starts. Otherwise deriveStatus's "translated text + empty history →
        // validated" fallback makes every cell light up validated for the
        // (multi-second) duration of the LLM call.
        dropLlmSeedHistory(doc, c.id, llmAuthor)
        recordHistoryEntry(doc, c.id, {
          value: "", source: "llm", author: llmAuthor, validated: false,
          examples: flatExamples.map((e) => ({ cellId: e.cellId, weight: e.coverageWeight })),
        })
      }

      // 2. Stream the segmented response and route closed <vN>...</vN> blocks
      //    to each cell as they arrive. Re-scanning the cumulative buffer is
      //    O(N²) but trivial at our scale; the regex naturally ignores any
      //    unclosed trailing tag.
      const filledText = new Map<number, string>()
      const completedRe = /<v(\d+)>([\s\S]*?)<\/v\1>/g
      const consumeFull = (full: string) => {
        completedRe.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = completedRe.exec(full)) !== null) {
          const idx = Number(m[1])
          if (filledText.has(idx)) continue
          const cell = chunk[idx - 1]
          if (!cell) continue
          const text = m[2].trim()
          writeCell(cell.id, text)
          filledText.set(idx, text)
        }
      }

      const examplesForPrompt: PassageExample[] = passages.map((p) => ({
        cells: p.cells.map((c) => ({ source: c.source, target: c.target })),
      }))
      const messages = buildBatchPrompt({
        sourceLanguage, targetLanguage,
        systemPrompt: effectiveSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        cells: chunk.map((c) => ({ source: c.original })),
        examples: examplesForPrompt,
        priorBatch: priorBatch.length ? priorBatch : undefined,
      })

      let result = ""
      try {
        result = await complete({
          settings: effectiveSettings, session, messages,
          stream: true,
          onChunk: (full) => consumeFull(full),
        })
      } catch (err) {
        // Whole sub-batch failed before any cell received content — mark every
        // still-generating cell in this chunk as errored and stop. Don't
        // advance to subsequent sub-batches: if the model/network is down
        // there's no point trying again 30 cells later.
        const msg = err instanceof Error ? err.message : "Failed"
        for (let i = 0; i < chunk.length; i++) {
          if (filledText.has(i + 1)) continue
          const c = chunk[i]
          // Drop the seed so the cell isn't stuck with an empty LLM entry.
          dropLlmSeedHistory(doc, c.id, llmAuthor)
          setCompleting((p) => new Map(p).set(c.id, "error"))
          setErrors((p) => new Map(p).set(c.id, msg))
        }
        posthog.captureException(err instanceof Error ? err : new Error(String(err)))
        return
      }

      // Final pass: in non-streaming mode (frontier path) onChunk never fired,
      // so we parse the returned text now. Idempotent in stream mode.
      consumeFull(result)

      // Record history + status for cells that round-tripped; queue the rest
      // for single-cell fallback so a couple of dropped tags don't lose the
      // user's whole batch. In both cases drop the seed entry first so we
      // don't accumulate phantom empty-LLM entries — completeSingle seeds
      // its own when it picks up a fallback.
      for (let i = 0; i < chunk.length; i++) {
        const cell = chunk[i]
        const text = filledText.get(i + 1)
        dropLlmSeedHistory(doc, cell.id, llmAuthor)
        if (text !== undefined) {
          if (commitCompletedCell) {
            await commitCompletedCell(cell, text, llmAuthor)
          }
          appendCellHistory(doc, cell.id, {
            value: text,
            source: "llm",
            author: llmAuthor,
            validated: false,
            examples: flatExamples.map((e) => ({ cellId: e.cellId, weight: e.coverageWeight })),
          })
          setCompleting((p) => new Map(p).set(cell.id, "done"))
        } else {
          fallbackQueue.push(cell)
        }
      }

      // Carry the just-translated cells into the next sub-batch as continuity
      // few-shot.
      priorBatch = chunk
        .map((c, i) => {
          const t = filledText.get(i + 1)
          return t ? { source: c.original, target: t } : null
        })
        .filter((x): x is { source: string; target: string } => x !== null)

      posthog.capture("ai batch translation chunk completed", {
        provider,
        model: effectiveSettings.model || "frontier-default",
        cell_count: chunk.length,
        filled_count: filledText.size,
        fallback_count: chunk.length - filledText.size,
        example_count: flatExamples.length,
      })
    }

    // Per-cell fallback for any cells whose <vN> never closed.
    for (const cell of fallbackQueue) {
      await completeSingle(cell)
    }
  }, [doc, effectiveSettings, isConfigured, isAvailable, sourceLanguage, targetLanguage, searchPassages, session, provider, completeSingle, commitCompletedCell])

  return { completeSingle, completeBatch, isConfigured, isAvailable, completing, examples, errors }
}
