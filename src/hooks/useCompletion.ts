// Phase 2c-gamma → AQU-174 → AQU-211: useCompletion drives the LLM stream and
// reports per-cell completion status. Both single-cell and batch completions
// auto-commit the generated text as an *unvalidated* cell; review happens
// through the validation workflow (the gutter validation circle), not an inline
// Tab/Esc accept/reject step. The streaming preview is shown only while
// generating.

import { useState, useCallback } from "react"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ScoredPair } from "@/lib/search/dual-index"
import { getUserProviderOverride } from "@/lib/store/user-provider-override"

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
import { buildPrompt, buildBatchPrompt, buildParagraphPrompt, complete, resolveProvider, DEFAULT_SYSTEM_PROMPT, collectValidatedPairs, type PassageExample } from "@/lib/completion/completion-service"
import { paragraphGroupForCell } from "@/lib/parsers/paragraphs"
import { parseParagraphResponse } from "@/lib/completion/paragraph-protocol"
import {
  resetBatchCompletionState,
  clearBatchCompletionProgress,
  incrementBatchCompletionDone,
  incrementBatchCompletionFailed,
  isBatchCompletionCancelled,
  getBatchCompletionSignal,
  cancelBatchCompletion,
} from "@/lib/completion/batch-completion"
import type { TranslationRule } from "@/lib/parsers/types"
import type { PassageHit } from "./useSearchIndex"
import { useFrontierHealth } from "@/lib/completion/frontier-health"
import posthog from "@/lib/posthog"
import { memMark } from "@/lib/perf-log"
import { compressExampleSource, dedupeExamples, dropPrecedingContextDuplicates, dropValidatedPairDuplicates } from "@/lib/completion/compress-examples"
import { noteAbAssignment } from "@/lib/ab/feedback"
import { gatherPrecedingContext, gatherFollowingSource, DEFAULT_DRAFT_CONTEXT, type DraftContextSettings } from "@/lib/completion/draft-context"
import type { AiDraftProvenance } from "@/lib/sync/outbox-types"

// Cap per LLM call. Above this we split into independent review packages.
// Tuned for typical context windows; revisit if real selections start brushing
// up against model limits.
// Keep generation/review units small enough for a human to inspect as one
// coherent work package. Research supports 5–10 consecutive items as a useful
// review unit; larger files still run, but are split into independently
// reviewable chunks.
const MAX_CELLS_PER_CALL = 10

// AQU-620: a "regenerate" request re-drafts a cell that already has a
// prediction. The project's configured temperature is tuned low for a stable
// first draft, so repeating generation yields effectively the same text. When
// the user explicitly asks for another iteration we raise the sampling
// temperature (unless the project is already hotter) so the new candidate
// differs. Scoped to regenerate only — first-draft generation is unchanged.
const REGENERATE_TEMPERATURE = 0.8

// Default settings for projects that haven't customized anything yet.
// Frontier provider + default system prompt, no custom endpoint.
// Exported for other LLM call sites (e.g. back-translation) that must apply
// the same "project settings else Frontier default" precedence.
export const FALLBACK_COMPLETION_SETTINGS: CompletionSettings = {
  provider: "frontier",
  endpoint: "",
  model: "",
  maxTokens: 512,
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  llmHealthPenalty: 0.1,
  top_k: 15,
  contextSize: "medium",
  useOnlyValidatedExamples: true,
  main_chat_language: "",
  fewShotExampleFormat: "source-and-target",
}

type CommitCompletedCell = (
  cell: CellData,
  text: string,
  author: string,
  provenance: AiDraftProvenance,
) => Promise<void>

const PROMPT_VERSION = "translation-draft-v1"

function promptFingerprint(prompt: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < prompt.length; index++) {
    hash ^= prompt.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function uniqueExampleIds(...groups: Array<Array<string | undefined>>): string[] {
  return Array.from(new Set(groups.flat().filter((id): id is string => Boolean(id))))
}

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
  allCells?: CellData[] | (() => CellData[]),
  /** The project brief's L1 summary — injected into every prompt (Task 6). */
  briefSummary?: string,
  draftContext: DraftContextSettings = DEFAULT_DRAFT_CONTEXT,
) {
  const [completing, setCompleting] = useState<Map<string, string>>(new Map())
  const [examples, setExamples] = useState<Map<string, ScoredPair[]>>(new Map())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  // Phase 2c-gamma: streaming output is held here until a writeback path lands.
  const [previews, setPreviews] = useState<Map<string, string>>(new Map())

  // Missing settings means "Frontier default with in-memory fallback" — we
  // don't persist anything until the user customizes.
  const effectiveSettings = settings ?? FALLBACK_COMPLETION_SETTINGS
  // A per-device override (user Settings) always beats the project settings.
  // Mirror the same precedence that complete() applies so isConfigured is
  // consistent with what the request will actually use.
  const deviceOverride = getUserProviderOverride()
  const resolvedSettings: CompletionSettings = deviceOverride
    ? { ...effectiveSettings, provider: "custom", endpoint: deviceOverride.endpoint, model: deviceOverride.model || effectiveSettings.model, apiKey: deviceOverride.apiKey }
    : effectiveSettings
  const provider = resolveProvider(resolvedSettings)
  const modelName = resolvedSettings.model || "frontier-default"
  const { available: frontierAvailable } = useFrontierHealth()

  // "Configured" = the user has done the setup. Frontier: signed in.
  // Custom: endpoint + model. Service reachability (`isAvailable` below) is
  // a separate, runtime concern — folding it in here causes the AI setup
  // dialog to re-prompt every time the health probe fails, even though the
  // user already configured a provider.
  const isConfigured = provider === "frontier"
    ? Boolean(session?.jwt)
    : Boolean(resolvedSettings.endpoint && resolvedSettings.model)

  // "Available" = service is reachable right now. Used to disable Generate
  // with a clear "service unavailable" message — never to gate setup.
  const isAvailable = provider === "frontier" ? frontierAvailable : true
  const getAllCells = useCallback(
    () => typeof allCells === "function" ? allCells() : allCells ?? [],
    [allCells],
  )
  const draftProvenance = useCallback((
    mode: AiDraftProvenance["mode"],
    exampleIds: string[],
    approvedExampleCount: number,
  ): AiDraftProvenance => ({
    model: modelName,
    provider,
    promptVersion: `${PROMPT_VERSION}:${promptFingerprint(effectiveSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT)}`,
    exampleIds,
    generatedAt: Date.now(),
    mode,
    projectState: {
      sourceLanguage,
      targetLanguage,
      approvedExampleCount,
    },
  }), [effectiveSettings.systemPrompt, modelName, provider, sourceLanguage, targetLanguage])

  const completeSingle = useCallback(async (
    cell: CellData,
    signal?: AbortSignal,
    opts?: { regenerate?: boolean },
  ) => {
    if (!isConfigured || !isAvailable) return
    // AQU-620: raise the temperature for an explicit regenerate so the second
    // request varies; leave first-draft generation on the configured value.
    const generationSettings: CompletionSettings = opts?.regenerate
      ? { ...effectiveSettings, temperature: Math.max(effectiveSettings.temperature ?? 0, REGENERATE_TEMPERATURE) }
      : effectiveSettings

    setCompleting((p) => new Map(p).set(cell.id, "searching"))
    // top_k controls how many approved examples are requested. The injected
    // search adapter is drafting-specific and enforces validatedOnly=true on
    // the server; this is not a user-tunable trust boundary.
    const topK = effectiveSettings.top_k ?? 15
    let found: ScoredPair[] = []
    try {
      found = await search(cell.original, topK, cell.id)
    } catch (err) {
      console.warn("[useCompletion] few-shot retrieval failed:", err)
    }
    setExamples((p) => new Map(p).set(cell.id, found))
    setCompleting((p) => new Map(p).set(cell.id, "generating"))

    // Collect validated pairs from the project's cells, ranked by relevance to
    // the cell being drafted. These represent human corrections — "fix it once,
    // the system learns." Limit to top_k most-relevant to keep the prompt tight.
    const corpusCells = getAllCells()
    const validatedPairs = collectValidatedPairs(corpusCells, cell.original, topK)

    try {
      // Left-context = committed target of the preceding cells (D4).
      const precedingContext = gatherPrecedingContext(
        corpusCells,
        cell.id,
        draftContext.precedingTargetCells,
      )

      // Compress the retrieved examples (deterministic source-span truncation using the
      // matched-token provenance the search already returns) and drop near-duplicates,
      // so the freed budget can hold the discourse window below. (D6)
      // Examples that duplicate a preceding-context cell OR a validated pair are dropped
      // first (on the FULL source, before compression, so the match is exact cell
      // identity): preceding-context and validated pairs are the stronger, exact signals
      // and both render ahead of retrieved examples in the prompt, so we keep them and
      // avoid rendering the same cell twice (which only bloats the prompt / prefill —
      // AQU-617).
      const compressedExamples = dedupeExamples(
        dropValidatedPairDuplicates(
          dropPrecedingContextDuplicates(found, precedingContext),
          validatedPairs,
        ).map((e) => ({
          source: compressExampleSource(e.source, { matchedTokens: e.matchedTokens }),
          target: e.target,
        })),
      )

      const messages = buildPrompt({
        sourceLanguage, targetLanguage,
        systemPrompt: effectiveSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        sourceText: cell.original,
        examples: compressedExamples,
        rules,
        validatedPairs,
        exampleFormat: effectiveSettings.fewShotExampleFormat,
        briefSummary,
        precedingContext,
      })
      const result = await complete({
        settings: generationSettings, session,
        messages,
        stream: true,
        onChunk: (text) => {
          setPreviews((p) => new Map(p).set(cell.id, text))
        },
        signal,
        // Model A/B: remember which experiment request drafted this cell so the
        // user's validate/edit gesture can be attributed to the served model.
        onAbAssignment: (ab) => noteAbAssignment(cell.fileId, cell.id, ab),
      })
      posthog.capture("ai translation completed", {
        provider,
        model: modelName,
        source_language: sourceLanguage,
        target_language: targetLanguage,
        example_count: found.length,
        validated_pair_count: validatedPairs.length,
        rule_count: (rules ?? []).filter((r) => r.enabled).length,
        regenerate: Boolean(opts?.regenerate),
      })
      // AQU-211: auto-commit like the batch path. The cell lands unvalidated
      // and flows through the validation workflow — no inline accept/reject.
      const llmAuthor = modelName
      await commitCompletedCell?.(
        cell,
        result,
        llmAuthor,
        draftProvenance(
          "single",
          uniqueExampleIds(found.map((example) => example.cellId), validatedPairs.map((example) => example.cellId)),
          corpusCells.filter((candidate) => candidate.status === "validated").length,
        ),
      )
      setPreviews((p) => { const m = new Map(p); m.delete(cell.id); return m })
      setCompleting((p) => { const m = new Map(p); m.delete(cell.id); return m })
    } catch (err) {
      // AbortError: the user stopped the run — clear state without persisting
      // an error entry (no stuck spinner, no error badge on the cell).
      if (err instanceof DOMException && err.name === "AbortError") {
        setPreviews((p) => { const m = new Map(p); m.delete(cell.id); return m })
        setCompleting((p) => { const m = new Map(p); m.delete(cell.id); return m })
        return
      }
      posthog.captureException(err instanceof Error ? err : new Error(String(err)))
      setCompleting((p) => new Map(p).set(cell.id, "error"))
      setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
    }
  }, [effectiveSettings, isConfigured, isAvailable, sourceLanguage, targetLanguage, search, session, provider, modelName, commitCompletedCell, rules, getAllCells, briefSummary, draftContext, draftProvenance])

  // Segmented batch translation: each small sub-batch goes out as one
  // <vN>-framed prompt and the response is demuxed back to cells. This preserves
  // discourse context without claiming that larger joint calls are inherently
  // higher quality. Cells whose tag is
  // missing/malformed in the response fall through to single-cell completion;
  // the batch as a whole does not fail.
  //
  // AQU-235: Integrated with batch-completion progress store. The banner shows
  // progress and exposes a Stop button. Abort semantics:
  //   - cancelBatchCompletion() sets the cancel flag AND calls AbortController.abort().
  //   - The driver checks isBatchCompletionCancelled() before each chunk.
  //   - The in-flight fetch/stream receives the AbortSignal and terminates immediately.
  //   - Already-committed cells are unaffected; partial streaming text is discarded.
  const completeBatch = useCallback(async (cells: CellData[]) => {
    if (!isConfigured || !isAvailable) return

    const chunks: CellData[][] = []
    for (let i = 0; i < cells.length; i += MAX_CELLS_PER_CALL) {
      chunks.push(cells.slice(i, i + MAX_CELLS_PER_CALL))
    }

    posthog.capture("ai batch translation started", {
      provider,
      model: modelName,
      source_language: sourceLanguage,
      target_language: targetLanguage,
      cell_count: cells.length,
      chunk_count: chunks.length,
      max_cells_per_call: MAX_CELLS_PER_CALL,
    })

    // AQU-235 fix: resetBatchCompletionState supersedes any live run (cancels it)
    // and returns a fresh run ID. Every flag check, increment, and the
    // finally-clear pass this ID so a stale run cannot affect us.
    const runId = resetBatchCompletionState(cells.length)
    memMark(`completeBatch.start(${cells.length}c)`)
    const corpusCells = getAllCells()

    const fallbackQueue: CellData[] = []

    try {
      for (const chunk of chunks) {
        // Stop starting new sub-batches if cancelled between chunks.
        if (isBatchCompletionCancelled(runId)) break

        for (const c of chunk) setCompleting((p) => new Map(p).set(c.id, "searching"))
        const concatenated = chunk.map((c) => c.original).join(" ")
        let passages: PassageHit[] = []
        try {
          passages = await searchPassages(concatenated, 3, 2)
        } catch (err) {
          console.warn("[useCompletion] passage retrieval failed:", err)
        }

        // If we were superseded while awaiting searchPassages, bail out cleanly.
        if (isBatchCompletionCancelled(runId)) {
          for (const c of chunk) {
            setPreviews((p) => { const m = new Map(p); m.delete(c.id); return m })
            setCompleting((p) => { const m = new Map(p); m.delete(c.id); return m })
          }
          break
        }

        const flatExamples: ScoredPair[] = passages.flatMap((p) =>
          p.cells.filter((c) => c.hit).map((c) => ({
            cellId: c.cellId, fileId: p.fileId, source: c.source, target: c.target,
            score: 1, matchedTokens: [], coverageWeight: 1,
          }))
        )
        const llmAuthor = modelName
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
        const batchTopK = effectiveSettings.top_k ?? 15
        const batchValidatedPairs = collectValidatedPairs(corpusCells, concatenated, batchTopK)
        const messages = buildBatchPrompt({
          sourceLanguage, targetLanguage,
          systemPrompt: effectiveSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
          cells: chunk.map((c) => ({ source: c.original })),
          examples: examplesForPrompt,
          rules,
          validatedPairs: batchValidatedPairs,
          exampleFormat: effectiveSettings.fewShotExampleFormat,
          briefSummary,
        })

        // AQU-361: a sub-batch call gets one retry before it's given up on.
        // Most failures here are transient (timeout, 5xx, flaky network) and
        // a single retry clears the large majority without materially
        // slowing the run.
        let result = ""
        let chunkFailed = false
        let lastErr: unknown
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            result = await complete({
              settings: effectiveSettings, session, messages,
              stream: true,
              onChunk: (full) => consumeFull(full),
              // AQU-235 fix: getBatchCompletionSignal(runId) returns an
              // already-aborted signal when this run has been superseded.
              signal: getBatchCompletionSignal(runId),
              // Model A/B: one batch request drafts every cell in the chunk; the
              // first gesture on any of them reports (server keeps one outcome).
              onAbAssignment: (ab) => {
                for (const c of chunk) noteAbAssignment(c.fileId, c.id, ab)
              },
            })
            lastErr = undefined
            break
          } catch (err) {
            // AbortError: user cancelled (or run superseded) — clear all
            // still-pending cells cleanly and stop the whole run (this is
            // the one case where not continuing is correct: the user asked
            // to stop, or a newer run has taken over).
            if (err instanceof DOMException && err.name === "AbortError") {
              for (let i = 0; i < chunk.length; i++) {
                const c = chunk[i]
                setPreviews((p) => { const m = new Map(p); m.delete(c.id); return m })
                setCompleting((p) => { const m = new Map(p); m.delete(c.id); return m })
              }
              chunkFailed = true
              lastErr = err
              break
            }
            lastErr = err
            // First attempt failed on a real error — retry once immediately.
          }
        }

        if (lastErr) {
          if (lastErr instanceof DOMException && lastErr.name === "AbortError") break

          // AQU-361: sub-batch failed twice (original + one retry). Skip this
          // chunk — mark its still-uncommitted cells as errored — and CONTINUE
          // to the next chunk rather than abandoning the rest of the file.
          // The overall run reports the failure via the progress summary
          // (see incrementBatchCompletionFailed below) instead of going quiet.
          const msg = lastErr instanceof Error ? lastErr.message : "Failed"
          let skippedCount = 0
          for (let i = 0; i < chunk.length; i++) {
            if (filledText.has(i + 1)) continue
            const c = chunk[i]
            setCompleting((p) => new Map(p).set(c.id, "error"))
            setErrors((p) => new Map(p).set(c.id, msg))
            skippedCount += 1
          }
          if (skippedCount > 0) incrementBatchCompletionFailed(runId, skippedCount)
          posthog.captureException(lastErr instanceof Error ? lastErr : new Error(String(lastErr)))
          chunkFailed = true
        }

        if (chunkFailed) continue

        consumeFull(result)

        // AQU-235 fix: only commit and increment done when this run is still
        // live. If superseded between the await and here, skip commits so the
        // cancelled run does not persist AI text or inflate run B's counter.
        if (isBatchCompletionCancelled(runId)) {
          for (let i = 0; i < chunk.length; i++) {
            const c = chunk[i]
            setPreviews((p) => { const m = new Map(p); m.delete(c.id); return m })
            setCompleting((p) => { const m = new Map(p); m.delete(c.id); return m })
          }
          break
        }

        for (let i = 0; i < chunk.length; i++) {
          const cell = chunk[i]
          const text = filledText.get(i + 1)
          if (text !== undefined) {
            if (commitCompletedCell) {
              await commitCompletedCell(
                cell,
                text,
                llmAuthor,
                draftProvenance(
                  "batch",
                  uniqueExampleIds(
                    passages.flatMap((passage) => passage.cells.map((example) => example.cellId)),
                    batchValidatedPairs.map((example) => example.cellId),
                  ),
                  corpusCells.filter((candidate) => candidate.status === "validated").length,
                ),
              )
            }
            // AQU-235 fix: after await, re-check — another Start could have
            // superseded us during the commit. If so, do not increment or clear.
            if (isBatchCompletionCancelled(runId)) {
              setPreviews((p) => { const m = new Map(p); m.delete(cell.id); return m })
              setCompleting((p) => { const m = new Map(p); m.delete(cell.id); return m })
              // Clear remaining cells in this chunk then bail from the outer loop.
              for (let j = i + 1; j < chunk.length; j++) {
                const c = chunk[j]
                setPreviews((p) => { const m = new Map(p); m.delete(c.id); return m })
                setCompleting((p) => { const m = new Map(p); m.delete(c.id); return m })
              }
              break
            }
            // AQU-211: clear state once committed — no inline review step.
            setPreviews((p) => { const m = new Map(p); m.delete(cell.id); return m })
            setCompleting((p) => { const m = new Map(p); m.delete(cell.id); return m })
            incrementBatchCompletionDone(runId)
          } else {
            fallbackQueue.push(cell)
          }
        }

        // If we broke out of the inner loop due to supersession, stop chunks.
        if (isBatchCompletionCancelled(runId)) break

        posthog.capture("ai batch translation chunk completed", {
          provider,
          model: modelName,
          cell_count: chunk.length,
          filled_count: filledText.size,
          fallback_count: chunk.length - filledText.size,
          example_count: flatExamples.length,
          validated_pair_count: batchValidatedPairs.length,
          rule_count: (rules ?? []).filter((r) => r.enabled).length,
        })
      }

      // Per-cell fallback for any cells whose <vN> never closed — only if not cancelled.
      if (!isBatchCompletionCancelled(runId)) {
        for (const cell of fallbackQueue) {
          if (isBatchCompletionCancelled(runId)) break
          // AQU-235 fix: thread the batch signal into completeSingle so it is
          // visible to Stop during a batch. getBatchCompletionSignal(runId)
          // returns an already-aborted signal if this run has been superseded.
          await completeSingle(cell, getBatchCompletionSignal(runId))
          // Only increment if the run is still live after the await.
          if (!isBatchCompletionCancelled(runId)) {
            incrementBatchCompletionDone(runId)
          }
        }
      } else {
        // Clear pending fallback cells without erroring them.
        for (const cell of fallbackQueue) {
          setPreviews((p) => { const m = new Map(p); m.delete(cell.id); return m })
          setCompleting((p) => { const m = new Map(p); m.delete(cell.id); return m })
        }
      }
    } finally {
      // AQU-235 fix: clearBatchCompletionProgress(runId) is a no-op when runId
      // !== _currentRunId — a finishing run A cannot null run B's banner.
      clearBatchCompletionProgress(runId)
      memMark(`completeBatch.end(${cells.length}c)`)
    }
  }, [effectiveSettings, isConfigured, isAvailable, sourceLanguage, targetLanguage, searchPassages, session, provider, modelName, completeSingle, commitCompletedCell, rules, getAllCells, briefSummary, draftProvenance])

  // completeParagraph: draft a whole paragraph group as ONE model call, fan results
  // out to per-cell commits via the existing commitCompletedCell path (D3, D11).
  const completeParagraph = useCallback(async (startCellId: string, signal?: AbortSignal) => {
    if (!isConfigured || !isAvailable) return

    // 1. Identify paragraph group from the starting cell.
    const cells = getAllCells()
    const groupIds = paragraphGroupForCell(cells, startCellId)
    if (!groupIds.length) {
      console.warn("[useCompletion] completeParagraph: cell not found in any paragraph group", startCellId)
      return
    }

    const groupCells = groupIds
      .map((id) => cells.find((c) => c.id === id))
      .filter((c): c is CellData => c !== undefined)

    if (!groupCells.length) return

    // AQU (p1-paragraph-ui-wiring, coordinator adjudication): a paragraph
    // draft must NEVER overwrite an already-validated cell — the confirm
    // dialog promises "cells already validated are skipped," matching the
    // single-cell UI (the Regenerate rail button is likewise hidden once
    // cell.status === "validated"). Validated cells are excluded from the
    // model request entirely (not just the commit step) so the protocol
    // never even asks for them; parseParagraphResponse only reconciles
    // `expectedIds`, so leaving them out never flags them missing.
    const draftCells = groupCells.filter((c) => c.status !== "validated")

    if (!draftCells.length) {
      // Every cell in the group is already validated — nothing to draft.
      return
    }

    // Mark only the cells actually being drafted as "generating". Validated
    // cells are left untouched (no pulsing ring — they were never queued).
    for (const c of draftCells) setCompleting((p) => new Map(p).set(c.id, "generating"))

    // Track which cells were actually committed so a mid-loop commit failure
    // does NOT relabel already-persisted cells as errored (declared outside the
    // try so the catch can read it).
    const committedIds = new Set<string>()

    try {
      // 2. Gather discourse window: preceding committed TARGET context (D4).
      // Left-context is the COMMITTED TARGET of preceding paragraphs (not source): this is what
      // gives real discourse flow — connectives and participant reference that follow what was
      // actually said in the target language. Falls back to source before anything is committed. (D4)
      const precedingContext = gatherPrecedingContext(
        cells,
        startCellId,
        draftContext.precedingTargetCells,
        true, // D4 source-fallback: paragraph path shows preceding source when no target committed yet
      )

      // Validated pairs from living memory for relevance-ranked few-shot.
      const topK = effectiveSettings.top_k ?? 15
      const concatenated = draftCells.map((c) => c.original).join(" ")
      const validatedPairs = collectValidatedPairs(cells, concatenated, topK)

      // Retrieve passage examples for the paragraph's source text.
      let passages: import("./useSearchIndex").PassageHit[] = []
      try {
        passages = await searchPassages(concatenated, 3, 2)
      } catch (err) {
        console.warn("[useCompletion] completeParagraph: passage retrieval failed:", err)
      }

      const examplesForPrompt: PassageExample[] = passages.map((p) => ({
        cells: p.cells.map((c) => ({ source: c.source, target: c.target })),
      }))

      // 3. Build the paragraph prompt.
      const messages = buildParagraphPrompt({
        sourceLanguage,
        targetLanguage,
        systemPrompt: effectiveSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        // Full group, IN POSITION (coordinator adjudication): a validated
        // cell mid-group must not leave a silent gap that makes its drafted
        // neighbors read as artificially adjacent. Locked (validated) cells
        // carry `lockedTarget` so buildParagraphPrompt renders them as a
        // reference segment instead of a `<c id>` tag — they are never
        // requested from the model.
        cells: groupCells.map((c) => ({
          cellId: c.id,
          source: c.original,
          ...(c.status === "validated" ? { lockedTarget: c.translated } : {}),
        })),
        examples: examplesForPrompt,
        validatedPairs,
        rules,
        briefSummary,
        exampleFormat: effectiveSettings.fewShotExampleFormat,
        precedingContext,
        // Following-source context (right side of discourse window, D4): the
        // source of cells after the paragraph group, same file. Reuses the
        // preceding budget as a symmetric window size for v1.
        // SWARM-TODO(p1-followups): split into its own followingSourceCells budget + settings UI (D10).
        followingSource: gatherFollowingSource(
          cells,
          groupIds[groupIds.length - 1],
          draftContext.precedingTargetCells,
        ),
      })

      // 4. Call model (on-complete; progressive streaming disabled for Frontier per spec).
      const result = await complete({
        settings: effectiveSettings,
        session,
        messages,
        // SWARM-TODO(p1-draft): enable progressive streaming here once Frontier SSE fix ships
        // (the tag format already supports it — see paragraph-protocol.ts).
        stream: false,
        signal,
        // Model A/B: the paragraph request drafts the whole group.
        onAbAssignment: (ab) => {
          for (const c of draftCells) noteAbAssignment(c.fileId, c.id, ab)
        },
      })

      // 5. Parse + reconcile LOUDLY (D11). Validated cells were excluded from
      // the request above, so they're correctly absent from `expectedIds` —
      // parseParagraphResponse never flags them missing.
      const expectedIds = draftCells.map((c) => c.id)
      const { mapped, missing, extra } = parseParagraphResponse(result, expectedIds)

      // Surface extra (unknown) tags as a warning — never commit them.
      if (extra.length) {
        const msg = `[completeParagraph] extra/unknown cell ids in model response (discarded): ${extra.join(", ")}`
        console.warn(msg)
        // Surface in hook errors so callers can show a toast/badge if desired.
        for (const id of extra) {
          setErrors((p) => new Map(p).set(id, `Unknown tag in response: ${id}`))
        }
      }

      // Surface missing cells as warnings — they are flagged, NEVER committed empty.
      if (missing.length) {
        const msg = `[completeParagraph] cells missing from model response (not committed): ${missing.join(", ")}`
        console.warn(msg)
        for (const id of missing) {
          setErrors((p) => new Map(p).set(id, `Cell not translated by model: ${id}`))
          // Clear the "generating" spinner for the missing cell.
          setCompleting((p) => { const m = new Map(p); m.delete(id); return m })
        }
      }

      // 6. Fan out: commit each mapped cell via the EXISTING commitCompletedCell path.
      const llmAuthor = modelName
      for (const { cellId, text } of mapped) {
        const cell = draftCells.find((c) => c.id === cellId)
        if (!cell) continue
        // D11 trust-killer guard: a present-but-empty tag (<c id="…"></c>) is
        // "no emitted content" just like a missing tag — flag it and NEVER commit
        // an empty cell. parseParagraphResponse reports the tag as present (mapped),
        // but the don't-commit-empty policy lives here in the draft path.
        if (!text.trim()) {
          console.warn(`[completeParagraph] empty content for cell (not committed): ${cellId}`)
          setErrors((p) => new Map(p).set(cellId, `Cell not translated by model: ${cellId}`))
          setCompleting((p) => { const m = new Map(p); m.delete(cellId); return m })
          continue
        }
        setPreviews((p) => new Map(p).set(cellId, text))
        await commitCompletedCell?.(
          cell,
          text,
          llmAuthor,
          draftProvenance(
            "paragraph",
            uniqueExampleIds(
              passages.flatMap((passage) => passage.cells.map((example) => example.cellId)),
              validatedPairs.map((example) => example.cellId),
            ),
            cells.filter((candidate) => candidate.status === "validated").length,
          ),
        )
        committedIds.add(cellId)
        setPreviews((p) => { const m = new Map(p); m.delete(cellId); return m })
        setCompleting((p) => { const m = new Map(p); m.delete(cellId); return m })
      }

      posthog.capture("ai paragraph translation completed", {
        provider,
        model: modelName,
        source_language: sourceLanguage,
        target_language: targetLanguage,
        group_size: groupCells.length,
        drafted_count: draftCells.length,
        skipped_validated_count: groupCells.length - draftCells.length,
        mapped_count: mapped.length,
        committed_count: committedIds.size,
        missing_count: missing.length,
        extra_count: extra.length,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        for (const c of draftCells) {
          setPreviews((p) => { const m = new Map(p); m.delete(c.id); return m })
          setCompleting((p) => { const m = new Map(p); m.delete(c.id); return m })
        }
        return
      }
      posthog.captureException(err instanceof Error ? err : new Error(String(err)))
      const msg = err instanceof Error ? err.message : "Failed"
      for (const c of draftCells) {
        // Don't relabel a cell that was already committed before the failure —
        // its AI draft is persisted; only the still-uncommitted cells errored.
        if (committedIds.has(c.id)) {
          setCompleting((p) => { const m = new Map(p); m.delete(c.id); return m })
          continue
        }
        setCompleting((p) => new Map(p).set(c.id, "error"))
        setErrors((p) => new Map(p).set(c.id, msg))
      }
    }
  }, [effectiveSettings, isConfigured, isAvailable, sourceLanguage, targetLanguage, searchPassages, session, provider, modelName, commitCompletedCell, rules, getAllCells, briefSummary, draftContext, draftProvenance])

  return { completeSingle, completeBatch, completeParagraph, cancelCompletion: cancelBatchCompletion, isConfigured, isAvailable, completing, examples, errors, previews }
}
