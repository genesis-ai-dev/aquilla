import {
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"
import posthog from "@/lib/posthog"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { fetchFileCells } from "@/lib/sync/cells-read"
import { emitTargetCellCommits, type CellCommitInput } from "@/lib/sync/events-emit"
import type { AiDraftProvenance } from "@/lib/sync/outbox-types"
import { alignIdmlStyles, type AlignStylesCell } from "./align-styles"
import {
  stitchIdmlSlotTexts,
  tryDeterministicIdmlSlotStitch,
  type IdmlRepairMessage,
  type NormalizedCompletion,
} from "./completion"
import {
  distributeTranslationLikeSource,
  readSourceDistributionSlots,
} from "./segment-distribution"

const ALIGN_CONCURRENCY = 4
const COMMIT_CHUNK = 100

export interface IdmlReimportAlignCell extends AlignStylesCell {
  readonly sourceEventId?: string
  readonly targetEventId?: string
  readonly laneId?: string | null
}

/** What Update Existing should do with one re-imported IDML cell's target. */
export type IdmlReimportPlacement = "align" | "single" | "current" | "skip"

export interface IdmlReimportAlignAsk {
  (messages: readonly IdmlRepairMessage[], signal?: AbortSignal): Promise<string>
}

export interface IdmlReimportAlignHost {
  ask: IdmlReimportAlignAsk
  /** Recorded as the target commit's author, matching the editor's Align styles action. */
  author: string
  model: string
  provider: string
  flush: (eventIds: readonly string[]) => Promise<void>
}

export interface AlignedIdmlReimport {
  readonly cell: IdmlReimportAlignCell
  readonly completion: NormalizedCompletion
}

export interface IdmlReimportAlignOutcome {
  readonly aligned: AlignedIdmlReimport[]
  readonly unchanged: number
  readonly failed: number
  readonly skipped: number
}

/**
 * Pair a file's source and target rows after a re-import. The source row
 * carries the new protected HTML and v2 locator; the target row is the
 * translation reconcile left in place.
 */
export function pairedCellsForIdmlAlignment(
  rows: readonly CellRow[],
  lane = "",
): IdmlReimportAlignCell[] {
  const wantedLane = lane || ""
  const sources = new Map<string, CellRow>()
  const targets = new Map<string, CellRow>()
  for (const row of rows) {
    if (row.side === "source") sources.set(row.cellId, row)
    else if ((row.targetLang ?? "") === wantedLane) targets.set(row.cellId, row)
  }
  const cells: IdmlReimportAlignCell[] = []
  for (const [id, source] of sources) {
    const target = targets.get(id)
    cells.push({
      id,
      originalHtml: source.valueHtml ?? undefined,
      translated: target?.value ?? "",
      translatedHtml: target?.valueHtml ?? undefined,
      metadata: source.metadata ?? null,
      sourceEventId: source.eventId,
      targetEventId: target?.eventId,
      laneId: target?.laneId ?? null,
    })
  }
  return cells
}

/**
 * Multi-run cells whose target is not yet protected HTML go through Align
 * styles. A single editable run has only one place for the existing words, so
 * those are stitched without a model call. A target that already validates
 * against the new source is left alone.
 */
export function idmlReimportPlacement(cell: IdmlReimportAlignCell): IdmlReimportPlacement {
  const metadata = idmlMetadata(cell)
  if (!metadata || !cell.originalHtml || !hasTranslation(cell)) return "skip"
  if (targetMatchesSource(cell, metadata)) return "current"
  if (metadata.editableSlotIndexes.length >= 2) return "align"
  if (metadata.editableSlotIndexes.length === 1) return "single"
  return "skip"
}

export async function alignReimportedIdmlTargets(
  cells: readonly IdmlReimportAlignCell[],
  ask: IdmlReimportAlignAsk,
  options: {
    signal?: AbortSignal
    concurrency?: number
    onProgress?: (done: number, total: number) => void
  } = {},
): Promise<IdmlReimportAlignOutcome> {
  const placements = cells.map((cell) => idmlReimportPlacement(cell))
  const work = cells.filter((_, index) => placements[index] === "align" || placements[index] === "single")
  const aligned: AlignedIdmlReimport[] = []
  let unchanged = placements.filter((placement) => placement === "current").length
  let failed = 0
  const skipped = placements.filter((placement) => placement === "skip").length
  const total = work.length
  if (total > 0) options.onProgress?.(0, total)
  if (total === 0 || options.signal?.aborted) {
    return { aligned, unchanged, failed, skipped }
  }

  const limit = Math.max(1, options.concurrency ?? ALIGN_CONCURRENCY)
  let cursor = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      if (options.signal?.aborted) return
      const index = cursor
      cursor += 1
      if (index >= work.length) return
      const cell = work[index]!
      let finished = false
      try {
        const placed = await placeCell(cell, ask, options.signal)
        if (placed.kind === "aligned") aligned.push({ cell, completion: placed.completion })
        else if (placed.kind === "unchanged") unchanged += 1
        else failed += 1
        finished = true
        if (options.signal?.aborted) return
      } catch (error) {
        if (isAbort(error) || options.signal?.aborted) return
        const fallback = plainProtectedFallback(cell)
        if (fallback) aligned.push({ cell, completion: fallback })
        else {
          failed += 1
          console.warn("[align-styles] re-import alignment skipped", cell.id, error)
        }
        finished = true
      } finally {
        if (finished) {
          done += 1
          options.onProgress?.(Math.min(done, total), total)
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, total) }, () => worker()))
  return { aligned, unchanged, failed, skipped }
}

export function commitsForAlignedIdmlTargets(
  aligned: readonly AlignedIdmlReimport[],
  meta: {
    projectId: string
    fileId: string
    author: string
    model: string
    provider: string
    sourceLanguage: string
    targetLanguage: string
    targetLang?: string
  },
): CellCommitInput[] {
  const commits: CellCommitInput[] = []
  for (const { cell, completion } of aligned) {
    const parentId = cell.targetEventId ?? cell.sourceEventId ?? null
    if (!parentId) continue
    const provenance: AiDraftProvenance = {
      interventionId: crypto.randomUUID(),
      model: meta.model,
      provider: meta.provider,
      promptVersion: "align-styles-v1",
      exampleIds: [],
      generatedAt: Date.now(),
      mode: "align-styles",
      projectState: {
        sourceLanguage: meta.sourceLanguage,
        targetLanguage: meta.targetLanguage,
        approvedExampleCount: 0,
      },
    }
    commits.push({
      projectId: meta.projectId,
      fileId: meta.fileId,
      cellId: cell.id,
      parentId,
      sourceEventId: cell.sourceEventId ?? null,
      ...(meta.targetLang ? { targetLang: meta.targetLang } : {}),
      ...(cell.laneId ? { laneId: cell.laneId } : {}),
      value: completion.value,
      ...(completion.valueHtml !== undefined ? { valueHtml: completion.valueHtml } : {}),
      author: meta.author,
      aiSuggestion: true,
      aiDraft: provenance,
    })
  }
  return commits
}

export async function alignReimportedIdmlFile(args: {
  projectId: string
  fileId: string
  lane?: string
  getToken: (fileId: string) => Promise<string | null>
  host: IdmlReimportAlignHost
  sourceLanguage: string
  targetLanguage: string
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}): Promise<IdmlReimportAlignOutcome> {
  const empty: IdmlReimportAlignOutcome = { aligned: [], unchanged: 0, failed: 0, skipped: 0 }
  if (args.signal?.aborted) return empty
  const jwt = await args.getToken(args.fileId)
  if (!jwt || args.signal?.aborted) return empty
  const rows = await loadPairedRows(args.projectId, args.fileId, args.lane ?? "", jwt, args.signal)
  if (args.signal?.aborted) return empty
  const cells = pairedCellsForIdmlAlignment(rows, args.lane ?? "")
  const outcome = await alignReimportedIdmlTargets(cells, args.host.ask, {
    signal: args.signal,
    onProgress: args.onProgress,
  })
  const commits = commitsForAlignedIdmlTargets(outcome.aligned, {
    projectId: args.projectId,
    fileId: args.fileId,
    author: args.host.author,
    model: args.host.model,
    provider: args.host.provider,
    sourceLanguage: args.sourceLanguage,
    targetLanguage: args.targetLanguage,
    targetLang: args.lane,
  })
  const eventIds: string[] = []
  try {
    for (let offset = 0; offset < commits.length; offset += COMMIT_CHUNK) {
      if (args.signal?.aborted) break
      const ids = await emitTargetCellCommits(commits.slice(offset, offset + COMMIT_CHUNK))
      eventIds.push(...ids)
    }
    if (eventIds.length > 0) await args.host.flush(eventIds)
  } catch (error) {
    console.warn("[align-styles] re-import alignment could not be saved", error)
  }
  if (outcome.aligned.length > 0) {
    posthog.capture("ai styles aligned", {
      provider: args.host.provider,
      model: args.host.model,
      source_language: args.sourceLanguage,
      target_language: args.targetLanguage,
      aligned_count: outcome.aligned.length,
      file_id: args.fileId,
      bulk: true,
    })
  }
  return outcome
}

/**
 * When Align styles cannot place the words, keep the translation inside the
 * source shell anyway. Export rejects a target that has plain text and no
 * protected HTML. The words follow the source runs when a label, verse span,
 * or parenthesis shows where they belong. Otherwise they stay in the first
 * run that is not apostrophe glue, so a failed model call still exports.
 */
function plainProtectedFallback(cell: IdmlReimportAlignCell): NormalizedCompletion | undefined {
  const metadata = idmlMetadata(cell)
  const plain = (cell.translated ?? "").trim() ? cell.translated ?? "" : ""
  if (!metadata || !cell.originalHtml || !plain || typeof document === "undefined") return undefined
  const sourceSlots = readSourceDistributionSlots(cell.originalHtml, metadata.editableSlotIndexes)
  const distributed = distributeTranslationLikeSource(sourceSlots, plain)
  const home = metadata.editableSlotIndexes.find((index) => {
    const slot = sourceSlots.find((entry) => entry.index === index)
    if (!slot) return true
    return !/source serif/i.test(slot.style) && !/^['\u2018\u2019\u201B\u02BC\u2032\u00B4]+$/.test(slot.text.trim())
  }) ?? metadata.editableSlotIndexes[0]
  if (home === undefined && !distributed) return undefined
  const texts = distributed ?? new Map<number, string>()
  if (!distributed) {
    for (const index of metadata.editableSlotIndexes) texts.set(index, index === home ? plain : "")
  }
  try {
    return stitchIdmlSlotTexts(cell, texts, { preserveWording: plain })
  } catch {
    return undefined
  }
}

async function placeCell(
  cell: IdmlReimportAlignCell,
  ask: IdmlReimportAlignAsk,
  signal?: AbortSignal,
): Promise<
  | { kind: "aligned"; completion: NormalizedCompletion }
  | { kind: "unchanged" }
  | { kind: "failed" }
> {
  if (idmlReimportPlacement(cell) === "single") {
    const draft = (cell.translated ?? "").trim() ? cell.translated! : (cell.translatedHtml ?? "")
    const completion = tryDeterministicIdmlSlotStitch(cell, draft)
    if (!completion) return { kind: "failed" }
    if (completion.valueHtml === cell.translatedHtml) return { kind: "unchanged" }
    return { kind: "aligned", completion }
  }
  const aligned = await alignIdmlStyles(cell, (messages) => ask(messages, signal))
  return aligned.changed
    ? { kind: "aligned", completion: aligned.completion }
    : { kind: "unchanged" }
}

function hasTranslation(cell: AlignStylesCell): boolean {
  if ((cell.translated ?? "").trim()) return true
  if (!cell.translatedHtml?.trim()) return false
  return cell.translatedHtml.replace(/<[^>]+>/g, "").trim().length > 0
}

function targetMatchesSource(cell: AlignStylesCell, metadata: IdmlFormatMetadataV2): boolean {
  if (!cell.originalHtml || !cell.translatedHtml) return false
  try {
    return validateIdmlTranslation(cell.originalHtml, cell.translatedHtml, metadata).valid
  } catch {
    return false
  }
}

function idmlMetadata(cell: AlignStylesCell): IdmlFormatMetadataV2 | undefined {
  const candidate = cell.metadata?.idml
  if (
    typeof candidate !== "object"
    || candidate === null
    || Array.isArray(candidate)
    || (candidate as { version?: unknown }).version !== 2
  ) {
    return undefined
  }
  const indexes = (candidate as { editableSlotIndexes?: unknown }).editableSlotIndexes
  if (!Array.isArray(indexes) || !indexes.every((index) => Number.isInteger(index))) return undefined
  return candidate as IdmlFormatMetadataV2
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

async function loadPairedRows(
  projectId: string,
  fileId: string,
  lane: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<CellRow[]> {
  const rows: CellRow[] = []
  let cursor: string | undefined
  for (;;) {
    if (signal?.aborted) return rows
    const page = await fetchFileCells(projectId, fileId, {
      paired: true,
      limit: 2000,
      ...(lane ? { lane } : {}),
      ...(cursor ? { cursor } : {}),
    }, jwt)
    rows.push(...page.cells)
    if (!page.nextCursor) return rows
    cursor = page.nextCursor
  }
}
