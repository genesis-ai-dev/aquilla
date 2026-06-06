// Phase 2c-gamma → FRO-174: useCompletion drives the LLM stream and reports
// per-cell completion status. Writebacks for single-cell completions are now
// user-gated: the UI shows a preview in "done" state, then Tab/Esc
// accept/reject via acceptCompletion / rejectCompletion. Batch completions
// auto-commit as before (no per-cell review UX for bulk runs).

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
import { buildPrompt, buildBatchPrompt, complete, resolveProvider, DEFAULT_SYSTEM_PROMPT, collectValidatedPairs, type PassageExample } from "@/lib/completion/completion-service"
import type { TranslationRule } from "@/lib/parsers/types"
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
  top_k: 5,
  contextSize: "medium",
  useOnlyValidatedExamples: false,
  main_chat_language: "",
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
  // SWARM-TODO(memory-wiring): ProjectWorkspace.tsx line ~692 — add two more
  // args to the useCompletion call:
  //   rules: rules,           (from `const { rules } = useRules(project ?? null, refresh)` at line 553)
  //   allCells: fileCells,    (from `const fileCells = cells` — the current file's cells snapshot)
  // e.g.:  useCompletion(...existingArgs, frontierSession, commitCompletedCell, rules, fileCells)
  rules?: TranslationRule[],
  allCells?: CellData[],
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
    // top_k controls how many search-retrieved examples are requested.
    // When useOnlyValidatedExamples is true, skip search-retrieved examples
    // and rely solely on collectValidatedPairs (validated-only examples).
    const topK = effectiveSettings.top_k ?? 5
    let found: ScoredPair[] = []
    try {
      if (!effectiveSettings.useOnlyValidatedExamples) {
        found = await search(cell.original, topK, cell.id)
      }
    } catch (err) {
      console.warn("[useCompletion] few-shot retrieval failed:", err)
    }
    setExamples((p) => new Map(p).set(cell.id, found))
    setCompleting((p) => new Map(p).set(cell.id, "generating"))

    // Collect validated pairs from the project's cells, ranked by relevance to
    // the cell being drafted. These represent human corrections — "fix it once,
    // the system learns." Limit to top_k most-relevant to keep the prompt tight.
    const validatedPairs = allCells
      ? collectValidatedPairs(allCells, cell.original, topK)
      : []

    try {
      const messages = buildPrompt({
        sourceLanguage, targetLanguage,
        systemPrompt: effectiveSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        sourceText: cell.original,
        examples: found.map((e) => ({ source: e.source, target: e.target })),
        rules,
        validatedPairs,
      })
      const result = await complete({
        settings: effectiveSettings, session,
        messages,
        stream: true,
        onChunk: (text) => {
          setPreviews((p) => new Map(p).set(cell.id, text))
        },
      })
      // FRO-174: single-cell completions stay in "done" preview state so the
      // user can Tab-accept or Esc-reject. acceptCompletion() below handles
      // the actual commitCompletedCell writeback with ai_suggestion provenance.
      // (Batch completions continue to auto-commit via the completeBatch path.)
      setPreviews((p) => new Map(p).set(cell.id, result))
      posthog.capture("ai translation completed", {
        provider,
        model: effectiveSettings.model || "frontier-default",
        source_language: sourceLanguage,
        target_language: targetLanguage,
        example_count: found.length,
        validated_pair_count: validatedPairs.length,
        rule_count: (rules ?? []).filter((r) => r.enabled).length,
      })
      setCompleting((p) => new Map(p).set(cell.id, "done"))
    } catch (err) {
      posthog.captureException(err instanceof Error ? err : new Error(String(err)))
      setCompleting((p) => new Map(p).set(cell.id, "error"))
      setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
    }
  }, [effectiveSettings, isConfigured, isAvailable, sourceLanguage, targetLanguage, search, session, provider, commitCompletedCell, rules, allCells])

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
      // Use the chunk's concatenated text as the relevance query so validated
      // pairs about the same topic/terms are ranked highest.
      const batchTopK = effectiveSettings.top_k ?? 5
      const batchValidatedPairs = allCells
        ? collectValidatedPairs(allCells, concatenated, batchTopK)
        : []
      const messages = buildBatchPrompt({
        sourceLanguage, targetLanguage,
        systemPrompt: effectiveSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        cells: chunk.map((c) => ({ source: c.original })),
        examples: examplesForPrompt,
        priorBatch: priorBatch.length ? priorBatch : undefined,
        rules,
        validatedPairs: batchValidatedPairs,
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
        validated_pair_count: batchValidatedPairs.length,
        rule_count: (rules ?? []).filter((r) => r.enabled).length,
      })
    }

    // Per-cell fallback for any cells whose <vN> never closed.
    for (const cell of fallbackQueue) {
      await completeSingle(cell)
    }
  }, [effectiveSettings, isConfigured, isAvailable, sourceLanguage, targetLanguage, searchPassages, session, provider, completeSingle, commitCompletedCell, rules, allCells])

  /**
   * FRO-174: Accept the queued completion preview for a cell.
   * Calls `commitCompletedCell` with `ai_suggestion` provenance, then clears
   * the preview + completing state so the overlay disappears.
   * No-op if the cell is not in "done" state or has no preview.
   */
  const acceptCompletion = useCallback(async (cell: CellData) => {
    const text = previews.get(cell.id)
    if (!text || completing.get(cell.id) !== "done") return
    const llmAuthor = effectiveSettings.model || "frontier-default"
    // Clear preview immediately for snappy UX; writeback is fire-and-forget.
    setPreviews((p) => { const m = new Map(p); m.delete(cell.id); return m })
    setCompleting((p) => { const m = new Map(p); m.delete(cell.id); return m })
    await commitCompletedCell?.(cell, text, llmAuthor)
    posthog.capture("ai translation accepted", {
      provider,
      model: effectiveSettings.model || "frontier-default",
      source_language: sourceLanguage,
      target_language: targetLanguage,
    })
  }, [previews, completing, effectiveSettings, commitCompletedCell, provider, sourceLanguage, targetLanguage])

  /**
   * FRO-174: Reject the queued completion preview for a cell.
   * Clears preview + completing state without writing anything.
   */
  const rejectCompletion = useCallback((cellId: string) => {
    setPreviews((p) => { const m = new Map(p); m.delete(cellId); return m })
    setCompleting((p) => { const m = new Map(p); m.delete(cellId); return m })
    posthog.capture("ai translation rejected", {
      provider,
      model: effectiveSettings.model || "frontier-default",
      source_language: sourceLanguage,
      target_language: targetLanguage,
    })
  }, [effectiveSettings, provider, sourceLanguage, targetLanguage])

  return { completeSingle, completeBatch, acceptCompletion, rejectCompletion, isConfigured, isAvailable, completing, examples, errors, previews }
}
