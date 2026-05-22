// Phase 2c-gamma: useCompletion still drives the LLM stream and reports
// per-cell completion status, but writebacks into the cell text are gone.
// Streaming output is collected in-memory; the UI surfaces it via
// previews + completing. Persisting the result requires a target.cell.commit
// writeback from completion - that hookup is deferred to v1.x.

import { useState, useCallback } from "react"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ScoredPair } from "@/lib/search/dual-index"

/**
 * Few-shot retrieval for the AI copilot. As of AD-13 (branching search) the
 * canonical implementation hits the server-side endpoint; this signature is
 * async so the ProjectWorkspace can wire it through `fetchBranchingSearch`.
 *
 * The result shape stays `ScoredPair` for now — internal consumers (history
 * entries, ExamplePanel) read `coverageWeight` and source/target text only,
 * and adapting at the call site keeps the rewire small.
 */
type SearchFn = (
  query: string,
  limit?: number,
  excludeId?: string,
) => Promise<ScoredPair[]>
import type { CellData } from "./useCells"
import { buildPrompt, buildBatchPrompt, complete, resolveProvider, DEFAULT_SYSTEM_PROMPT, type PassageExample } from "@/lib/completion/completion-service"
import type { PassageHit } from "./useSearchIndex"
import { useFrontierHealth } from "@/lib/completion/frontier-health"
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

/**
 * Passage-mode retrieval for the batch completion path. As of AD-13 the
 * canonical implementation hits the server `/branching-search/passages`
 * endpoint; signature is async so the ProjectWorkspace can inject a
 * fetcher that maps server `Passage` to the existing `PassageHit` shape.
 *
 * Fallback to a local in-memory index is the consumer's responsibility
 * (transient network failure shouldn't break batch translation outright).
 */
type SearchPassagesFn = (
  query: string,
  hits?: number,
  radius?: number,
) => Promise<PassageHit[]>

export function useCompletion(
  settings: CompletionSettings | undefined,
  sourceLanguage: string,
  targetLanguage: string,
  search: SearchFn,
  searchPassages: SearchPassagesFn,
  session: FrontierSession | null = null,
  commitCompletedCell?: CommitCompletedCell,
) {
  const [completing, setCompleting] = useState<Map<string, string>>(new Map())
  const [examples, setExamples] = useState<Map<string, ScoredPair[]>>(new Map())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  // Phase 2c-gamma: streaming output is held here until a writeback path lands.
  const [previews, setPreviews] = useState<Map<string, string>>(new Map())

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
    if (!isConfigured || !isAvailable) return

    setCompleting((p) => new Map(p).set(cell.id, "searching"))
    let found: ScoredPair[] = []
    try {
      found = await search(cell.original, 5, cell.id)
    } catch (err) {
      console.warn("[useCompletion] few-shot retrieval failed:", err)
    }
    setExamples((p) => new Map(p).set(cell.id, found))
    setCompleting((p) => new Map(p).set(cell.id, "generating"))

    const llmAuthor = effectiveSettings.model || "frontier-default"

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
          setPreviews((p) => new Map(p).set(cell.id, text))
        },
      })
      await commitCompletedCell?.(cell, result, llmAuthor)
      setPreviews((p) => new Map(p).set(cell.id, result))
      posthog.capture("ai translation completed", {
        provider,
        model: effectiveSettings.model || "frontier-default",
        source_language: sourceLanguage,
        target_language: targetLanguage,
        example_count: found.length,
      })
      setCompleting((p) => new Map(p).set(cell.id, "done"))
    } catch (err) {
      posthog.captureException(err instanceof Error ? err : new Error(String(err)))
      setCompleting((p) => new Map(p).set(cell.id, "error"))
      setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
    }
  }, [effectiveSettings, isConfigured, isAvailable, sourceLanguage, targetLanguage, search, session, provider, commitCompletedCell])

  // Segmented batch translation: each sub-batch goes out as one <vN>-framed
  // prompt and the response is demuxed back to cells. LLMs translate a passage
  // substantially better than the same verses in isolation, so we accept the
  // alignment risk in exchange for cross-verse context. Cells whose tag is
  // missing/malformed in the response fall through to single-cell completion;
  // the batch as a whole does not fail.
  const completeBatch = useCallback(async (cells: CellData[]) => {
    if (!isConfigured || !isAvailable) return

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

    let priorBatch: { source: string; target: string }[] = []
    const fallbackQueue: CellData[] = []

    for (const chunk of chunks) {
      for (const c of chunk) setCompleting((p) => new Map(p).set(c.id, "searching"))
      const concatenated = chunk.map((c) => c.original).join(" ")
      let passages: PassageHit[] = []
      try {
        passages = await searchPassages(concatenated, 3, 2)
      } catch (err) {
        console.warn("[useCompletion] passage retrieval failed:", err)
      }
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
      }

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
          setPreviews((p) => new Map(p).set(cell.id, text))
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
          setCompleting((p) => new Map(p).set(c.id, "error"))
          setErrors((p) => new Map(p).set(c.id, msg))
        }
        posthog.captureException(err instanceof Error ? err : new Error(String(err)))
        return
      }

      consumeFull(result)

      for (let i = 0; i < chunk.length; i++) {
        const cell = chunk[i]
        const text = filledText.get(i + 1)
        if (text !== undefined) {
          if (commitCompletedCell) {
            await commitCompletedCell(cell, text, llmAuthor)
          }
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
  }, [effectiveSettings, isConfigured, isAvailable, sourceLanguage, targetLanguage, searchPassages, session, provider, completeSingle, commitCompletedCell])

  return { completeSingle, completeBatch, isConfigured, isAvailable, completing, examples, errors, previews }
}
