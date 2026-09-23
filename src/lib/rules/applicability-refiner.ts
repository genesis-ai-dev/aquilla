/**
 * applicability-refiner.ts — agent-proposed, human-confirmed refinement of one
 * style rule's applicability graph (AQU-934 phase 3c).
 *
 * A rule arrives with a coarse reach ("global", "book:PSA"). This module asks
 * the model, segment by segment, whether the rule actually governs each one,
 * then COALESCES those per-segment verdicts into the fewest rows that express
 * them. Materializing one row per segment is exactly what the applicability
 * graph exists to avoid — inherited coverage is computed at read time
 * (applicability.ts), so segment rows are reserved for exceptions and for the
 * scattered remainder no coarser target can cover.
 *
 * Coalescing ladder, coarsest first (both for `applies` and for `excluded`):
 *   1. section — every judged cell of a "BOOK CH" section falls on this side,
 *      and there are at least MIN_SECTION_CELLS of them: one cell is evidence
 *      about a segment, never about its chapter.
 *   2. passage — a contiguous verse run of MIN_RUN_CELLS+ cells, emitted as
 *      one "BOOK C:V-V2" span. Contiguity is verse adjacency among the covered
 *      cells, so a rejected verse in the middle genuinely splits the run.
 *   3. segment — everything else, including cells whose ref does not parse
 *      (they degrade to a segment row rather than being dropped).
 * `excluded` rows are proposed only where the rule ALREADY reaches the cell by
 * inheritance — the explicit-override case; excluding a cell the rule never
 * reached would be a no-op row.
 *
 * Nothing here writes: the caller shows the proposals for confirmation and only
 * then persists them (as `assignedBy: "human"` — a person confirmed it).
 */

import { complete } from "@/lib/completion/completion-service"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CompletionSettings } from "@/lib/parsers/types"
import {
  parsePassageRef,
  resolveEffectiveRules,
  type ApplicabilityIndex,
  type ParsedPassageRef,
} from "./applicability"
import type { UsageCallback } from "./rule-suggester"
import type { ApplicabilityTargetType, CellCoordinates, StyleRule } from "./style-rule-types"

// ── Bounds ──────────────────────────────────────────────────────────────────

/** Cells per completion. Keeps one call's output inside a small token budget. */
export const CELLS_PER_BATCH = 60

/** Hard ceiling per run. The caller MUST say so in the UI when it truncates. */
export const MAX_CELLS_PER_RUN = 600

/** Below this, a section's evidence is about its segments, not the section. */
const MIN_SECTION_CELLS = 2

/** A lone verse is a segment; a run needs a second verse to be a run. */
const MIN_RUN_CELLS = 2

const MAX_CELL_CHARS = 400
const MAX_OUTPUT_TOKENS = 4096

// ── Shapes ──────────────────────────────────────────────────────────────────

/** One segment offered to the judge. */
export interface RefinerCell {
  id: string
  /** Source text the verdict is judged from. */
  text: string
  /** canonicalRef ("LUK 1:1"), when the cell has one. */
  ref?: string
}

/** The model's per-cell answer, after validation. */
export interface CellVerdict {
  cellId: string
  matches: boolean
  /** 0 to 1, when the model scored itself. */
  confidence?: number
  reason?: string
}

/** Relationships this module proposes — a verdict is either yes or no. */
export type ProposedRelationship = "applies" | "excluded"

/** One row offered for confirmation, with the evidence it stands on. */
export interface ProposedApplicability {
  targetType: ApplicabilityTargetType
  targetId: string
  relationship: ProposedRelationship
  /** Weakest covered verdict — a coalesced row is only as sure as its parts. */
  confidence?: number
  reason?: string
  coveredCellIds: string[]
}

// ── Verdict parsing ─────────────────────────────────────────────────────────

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/**
 * Parse a raw completion into verdicts. Robust to code fences and prose
 * wrappers (everything outside the outermost [] is ignored). Entries with a
 * non-string id, a non-boolean verdict, or — when `knownIds` is given — an id
 * that was not in the batch are dropped. The first entry for a cell wins, so a
 * self-contradicting answer cannot flip a verdict silently.
 */
export function parseCellVerdicts(raw: string, knownIds?: readonly string[]): CellVerdict[] {
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = cleaned.indexOf("[")
  const end = cleaned.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const allowed = knownIds ? new Set(knownIds) : null
  const seen = new Set<string>()
  const verdicts: CellVerdict[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.matches !== "boolean") continue
    const cellId = record.id.trim()
    if (!cellId || seen.has(cellId) || (allowed && !allowed.has(cellId))) continue
    seen.add(cellId)
    const verdict: CellVerdict = { cellId, matches: record.matches }
    const confidence = clampConfidence(record.confidence)
    if (confidence !== undefined) verdict.confidence = confidence
    if (typeof record.reason === "string" && record.reason.trim()) {
      verdict.reason = record.reason.trim()
    }
    verdicts.push(verdict)
  }
  return verdicts
}

// ── Coalescing (pure) ───────────────────────────────────────────────────────

/** Mirrors the private normalizer in applicability.ts — ids must key alike. */
function normalizeTargetId(type: ApplicabilityTargetType, targetId: string): string {
  const trimmed = targetId.trim()
  if (type === "genre") return trimmed.toLowerCase()
  if (type === "book" || type === "section") return trimmed.toUpperCase()
  return trimmed
}

function rowKey(type: ApplicabilityTargetType, targetId: string, relationship: string): string {
  return `${type} ${normalizeTargetId(type, targetId)} ${relationship}`
}

/** "LUK 1:1" / "LUK 1:1-4" — the canonicalRef span form passage rows carry. */
function serializeSpan(span: ParsedPassageRef): string {
  const head = `${span.book} ${span.chapter}:${span.verseStart}`
  return span.verseEnd > span.verseStart ? `${head}-${span.verseEnd}` : head
}

/** Every (target, relationship) the rule already carries, keyed for lookup. */
function existingRowKeys(index: ApplicabilityIndex, ruleId: string): Set<string> {
  const keys = new Set<string>()
  const entry = index.byRule.get(ruleId)
  if (!entry) return keys
  for (const [type, byId] of entry.exact) {
    for (const [id, existing] of byId) keys.add(rowKey(type, id, existing.relationship))
  }
  for (const { row, span } of entry.passages) {
    keys.add(rowKey("passage", serializeSpan(span), row.relationship))
  }
  return keys
}

interface Judged {
  verdict: CellVerdict
  coords: CellCoordinates
}

function summarize(covered: readonly Judged[]): Pick<ProposedApplicability, "confidence" | "reason"> {
  const summary: Pick<ProposedApplicability, "confidence" | "reason"> = {}
  const reason = covered.find((item) => item.verdict.reason)?.verdict.reason
  if (reason) summary.reason = reason
  const scores = covered
    .map((item) => item.verdict.confidence)
    .filter((score): score is number => score !== undefined)
  if (scores.length > 0) summary.confidence = Math.min(...scores)
  return summary
}

function proposal(
  targetType: ApplicabilityTargetType,
  targetId: string,
  relationship: ProposedRelationship,
  covered: readonly Judged[],
): ProposedApplicability {
  return {
    targetType,
    targetId,
    relationship,
    ...summarize(covered),
    coveredCellIds: covered.map((item) => item.verdict.cellId),
  }
}

/** Judged cells grouped by their "BOOK CH" section, in first-appearance order. */
function sectionBuckets(judged: readonly Judged[]): Map<string, Judged[]> {
  const buckets = new Map<string, Judged[]>()
  for (const item of judged) {
    const section = item.coords.section
    if (!section) continue
    const bucket = buckets.get(section)
    if (bucket) bucket.push(item)
    else buckets.set(section, [item])
  }
  return buckets
}

/**
 * Maximal runs of verse-adjacent cells within one book+chapter: a run extends
 * while the next span starts no later than one verse after the run's end, so
 * multi-verse cells ("LUK 1:1-2" then "LUK 1:3") join and a gap splits.
 */
function verseRuns(covered: readonly Judged[]): Array<{ span: ParsedPassageRef; cells: Judged[] }> {
  const byChapter = new Map<string, Array<{ span: ParsedPassageRef; cell: Judged }>>()
  for (const cell of covered) {
    const span = cell.coords.passageRef ? parsePassageRef(cell.coords.passageRef) : null
    if (!span) continue
    const key = `${span.book} ${span.chapter}`
    const list = byChapter.get(key)
    if (list) list.push({ span, cell })
    else byChapter.set(key, [{ span, cell }])
  }

  const runs: Array<{ span: ParsedPassageRef; cells: Judged[] }> = []
  for (const list of byChapter.values()) {
    const ordered = [...list].sort(
      (a, b) => a.span.verseStart - b.span.verseStart || a.span.verseEnd - b.span.verseEnd,
    )
    let current: { span: ParsedPassageRef; cells: Judged[] } | null = null
    for (const { span, cell } of ordered) {
      if (current && span.verseStart <= current.span.verseEnd + 1) {
        current.span.verseEnd = Math.max(current.span.verseEnd, span.verseEnd)
        current.cells.push(cell)
        continue
      }
      if (current) runs.push(current)
      current = { span: { ...span }, cells: [cell] }
    }
    if (current) runs.push(current)
  }
  return runs
}

/**
 * Coalesce one side of the verdicts into rows. `candidates` is the subset of
 * `judged` on this side; a section row needs the WHOLE judged bucket on this
 * side, because proposing coverage the run's own evidence contradicts is never
 * worth the row it saves.
 */
function coalesceSide(
  judged: readonly Judged[],
  candidates: readonly Judged[],
  relationship: ProposedRelationship,
): ProposedApplicability[] {
  const candidateIds = new Set(candidates.map((item) => item.verdict.cellId))
  const covered = new Set<string>()
  const rows: ProposedApplicability[] = []

  for (const [section, bucket] of sectionBuckets(judged)) {
    if (bucket.length < MIN_SECTION_CELLS) continue
    if (!bucket.every((item) => candidateIds.has(item.verdict.cellId))) continue
    rows.push(proposal("section", section, relationship, bucket))
    for (const item of bucket) covered.add(item.verdict.cellId)
  }

  const loose = candidates.filter((item) => !covered.has(item.verdict.cellId))
  for (const run of verseRuns(loose)) {
    if (run.cells.length < MIN_RUN_CELLS) continue
    rows.push(proposal("passage", serializeSpan(run.span), relationship, run.cells))
    for (const item of run.cells) covered.add(item.verdict.cellId)
  }

  for (const item of loose) {
    if (covered.has(item.verdict.cellId)) continue
    rows.push(proposal("segment", item.verdict.cellId, relationship, [item]))
  }
  return rows
}

export interface CoalesceInput {
  /** The rule being refined — its scope decides what "already applies" means. */
  rule: StyleRule
  verdicts: readonly CellVerdict[]
  /** cellId to coordinates. A verdict with no entry here is ignored. */
  coords: ReadonlyMap<string, CellCoordinates>
  /** The rule's current graph: sets inheritance, and blocks duplicate rows. */
  existing: ApplicabilityIndex
}

/**
 * Fold per-cell verdicts into the fewest rows that express them (PURE).
 * Positive rows come first, then the exclusions; within a side, section rows
 * precede passage rows precede segment rows. A row that duplicates one already
 * on the rule with the same relationship is dropped, and its cells stay
 * covered — the graph already says it.
 */
export function coalesceProposals({
  rule,
  verdicts,
  coords,
  existing,
}: CoalesceInput): ProposedApplicability[] {
  const judged: Judged[] = []
  const seen = new Set<string>()
  for (const verdict of verdicts) {
    const cellCoords = coords.get(verdict.cellId)
    if (!cellCoords || seen.has(verdict.cellId)) continue
    seen.add(verdict.cellId)
    judged.push({ verdict, coords: cellCoords })
  }

  const matched = judged.filter((item) => item.verdict.matches)
  // An exclusion is only meaningful where the rule reaches the cell today.
  const excludable = judged.filter(
    (item) =>
      !item.verdict.matches && resolveEffectiveRules([rule], existing, item.coords).length > 0,
  )

  const taken = existingRowKeys(existing, rule.id)
  return [
    ...coalesceSide(judged, matched, "applies"),
    ...coalesceSide(judged, excludable, "excluded"),
  ].filter((row) => {
    const key = rowKey(row.targetType, row.targetId, row.relationship)
    if (taken.has(key)) return false
    taken.add(key)
    return true
  })
}

// ── Judging run ─────────────────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You decide, segment by segment, whether ONE translation style rule governs a segment of text.

You are given the rule and a list of segments. Judge each segment on its own text: does this rule have anything to say about how this segment is translated?

Output ONLY a JSON array with this exact shape:
[{ "id": "the segment id exactly as given", "matches": true, "confidence": 0.9, "reason": "short clause naming what decided it" }]

Rules:
- Copy each id back exactly as given, and return one entry for EVERY segment.
- "matches": true only when the segment actually has the feature the rule is about — a rule about direct speech matches only segments that contain direct speech. A rule that could not change this segment's translation does not match it.
- "confidence": 0 to 1, how sure you are of that verdict.
- "reason": one short clause naming the feature in the segment, not a restatement of the rule.
- No markdown, no code fences, no commentary.`

function clip(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ")
  return collapsed.length <= MAX_CELL_CHARS ? collapsed : `${collapsed.slice(0, MAX_CELL_CHARS)}…`
}

function describeRule(rule: StyleRule): string {
  const lines = [`Rule: ${rule.instruction}`]
  if (rule.conditions) lines.push(`Conditions: ${rule.conditions}`)
  if (rule.exceptions) lines.push(`Exceptions: ${rule.exceptions}`)
  return lines.join("\n")
}

function buildBatchPrompt(rule: StyleRule, cells: readonly RefinerCell[]): string {
  const segments = cells
    .map(
      (cell) =>
        `id: ${cell.id}\nref: ${cell.ref ?? "(none)"}\ntext: ${clip(cell.text) || "(empty)"}`,
    )
    .join("\n\n")
  return `${describeRule(rule)}\n\nSegments:\n\n${segments}`
}

export interface RefineApplicabilityInput {
  rule: StyleRule
  /** Segments to inspect. Only the first MAX_CELLS_PER_RUN are judged. */
  cells: readonly RefinerCell[]
  coordsFor: (cell: RefinerCell) => CellCoordinates
  /** The rule's current applicability graph. */
  existingIndex: ApplicabilityIndex
  settings: CompletionSettings
  session?: FrontierSession | null
  /** Aborting stops between batches (and in flight) and coalesces what landed. */
  signal?: AbortSignal
  /** (0, total, 0) up front, then after each batch: judged, total, matches. */
  onProgress?: (inspected: number, total: number, matched: number) => void
  onLlmCall?: UsageCallback
}

/**
 * Judge each segment against the rule, then coalesce the verdicts into rows a
 * person can confirm. Completion errors propagate (fail fast); an abort keeps
 * the verdicts already collected. Nothing is persisted here.
 */
export async function refineApplicability(
  input: RefineApplicabilityInput,
): Promise<ProposedApplicability[]> {
  const cells = input.cells.slice(0, MAX_CELLS_PER_RUN)
  const verdicts: CellVerdict[] = []
  let matched = 0
  input.onProgress?.(0, cells.length, 0)

  for (let start = 0; start < cells.length; start += CELLS_PER_BATCH) {
    if (input.signal?.aborted) break
    const batch = cells.slice(start, start + CELLS_PER_BATCH)
    let raw: string
    try {
      raw = await complete({
        settings: {
          ...input.settings,
          maxTokens: Math.min(input.settings.maxTokens, MAX_OUTPUT_TOKENS),
          temperature: 0.1,
        },
        session: input.session ?? null,
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: buildBatchPrompt(input.rule, batch) },
        ],
        signal: input.signal,
      })
      input.onLlmCall?.({
        kind: "applicability-refine",
        model: input.settings.model,
        provider: input.settings.provider || "frontier",
      })
    } catch (err) {
      if (input.signal?.aborted) break
      throw err
    }

    for (const verdict of parseCellVerdicts(
      raw,
      batch.map((cell) => cell.id),
    )) {
      verdicts.push(verdict)
      if (verdict.matches) matched += 1
    }
    input.onProgress?.(Math.min(start + batch.length, cells.length), cells.length, matched)
  }

  const coords = new Map<string, CellCoordinates>()
  for (const cell of cells) coords.set(cell.id, input.coordsFor(cell))
  return coalesceProposals({
    rule: input.rule,
    verdicts,
    coords,
    existing: input.existingIndex,
  })
}
