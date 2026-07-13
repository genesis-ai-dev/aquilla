/**
 * Human-review effort metrics for AQU-311, derived from the event log.
 *
 * A draft contributes only after a `cell.validate` event approves the draft
 * itself or a human descendant commit. This avoids treating an abandoned edit
 * as final human work and makes the metric match the app's approval workflow.
 * Drafts require AQU-292 AI provenance; older commits without that marker are
 * intentionally excluded. Character-level NED is used instead of word-level TER.
 */

import { levenshteinOperations, normalizedEditDistance } from "./edit-distance"

export interface AiDraftProvenanceSnapshot {
  model?: string
  provider?: string
  promptVersion?: string
  exampleIds?: string[]
  projectState?: {
    sourceLanguage?: string
    targetLanguage?: string
    approvedExampleCount?: number
  }
}

/** A single machine draft and its final approved result. */
export interface PostEditPair {
  cellId: string
  fileId: string
  aiValue: string
  humanValue: string
  ned: number
  insertions: number
  deletions: number
  substitutions: number
  /** User who approved the result. */
  author: string
  /** Approval timestamp. */
  humanTs: number
  aiTs: number
  /** Draft-commit → first-approval wall time; includes time away from the editor. */
  reviewTimeMs: number
  acceptedAsIs: boolean
  provenance?: AiDraftProvenanceSnapshot
}

export interface CommitEvent {
  id: string
  parentId: string | null
  kind: string
  author: string
  serverTs: number
  serverSeq: number
  payload: unknown
  cellId?: string
}

interface TargetCommitPayload {
  value?: string
  ai_suggestion?: true
  ai_draft?: AiDraftProvenanceSnapshot
}

interface ValidationPayload {
  editEventId?: string
}

/** Extract approved draft→final pairs from one cell's event history. */
export function extractPostEditPairs(
  events: CommitEvent[],
  cellId: string,
  fileId: string,
): PostEditPair[] {
  const ordered = [...events].sort((a, b) => a.serverSeq - b.serverSeq)
  const commits = ordered.filter(
    (event) => event.kind === "target.cell.commit" || event.kind === "target.cell.create",
  )
  const commitsById = new Map(commits.map((event) => [event.id, event]))
  const pairedDraftIds = new Set<string>()
  const pairedApprovalIds = new Set<string>()
  const pairs: PostEditPair[] = []

  for (const approval of ordered) {
    if (approval.kind !== "cell.validate") continue
    const approvedId = (approval.payload as ValidationPayload | null)?.editEventId
    if (!approvedId || pairedApprovalIds.has(approvedId)) continue
    const approvedCommit = commitsById.get(approvedId)
    if (!approvedCommit) continue

    // Walk the approved commit's ancestry to the closest machine draft. This
    // naturally attributes a human correction after several re-drafts to the
    // most recent draft and also handles direct acceptance-as-is.
    let cursor: CommitEvent | undefined = approvedCommit
    let draft: CommitEvent | undefined
    const visited = new Set<string>()
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id)
      const payload = cursor.payload as TargetCommitPayload | null
      if (payload?.ai_suggestion === true) {
        draft = cursor
        break
      }
      cursor = cursor.parentId ? commitsById.get(cursor.parentId) : undefined
    }
    if (!draft || pairedDraftIds.has(draft.id)) continue

    const draftPayload = draft.payload as TargetCommitPayload
    const approvedPayload = approvedCommit.payload as TargetCommitPayload
    const aiValue = draftPayload.value ?? ""
    const humanValue = approvedPayload.value ?? ""
    const operations = levenshteinOperations(aiValue, humanValue)
    pairs.push({
      cellId,
      fileId,
      aiValue,
      humanValue,
      ned: normalizedEditDistance(aiValue, humanValue),
      ...operations,
      author: approval.author,
      humanTs: approval.serverTs,
      aiTs: draft.serverTs,
      reviewTimeMs: Math.max(0, approval.serverTs - draft.serverTs),
      acceptedAsIs: approvedCommit.id === draft.id,
      ...(draftPayload.ai_draft ? { provenance: draftPayload.ai_draft } : {}),
    })
    pairedDraftIds.add(draft.id)
    pairedApprovalIds.add(approvedId)
  }

  return pairs
}

export interface WeekBucket {
  weekStart: string
  avgNed: number
  count: number
}

export interface UserBucket {
  author: string
  avgNed: number
  count: number
}

export interface PostEditMetrics {
  pairs: PostEditPair[]
  byWeek: WeekBucket[]
  byUser: UserBucket[]
  overallAvgNed: number
  overallAvgReviewMs: number
  acceptanceRate: number
  totalCount: number
}

export function weekStart(epochMs: number): string {
  const d = new Date(epochMs)
  const day = d.getUTCDay()
  const diffToMonday = day === 0 ? 6 : day - 1
  const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() - diffToMonday)
  monday.setUTCHours(0, 0, 0, 0)
  return monday.toISOString().slice(0, 10)
}

export function aggregatePostEditMetrics(pairs: PostEditPair[]): PostEditMetrics {
  if (pairs.length === 0) {
    return {
      pairs: [],
      byWeek: [],
      byUser: [],
      overallAvgNed: 0,
      overallAvgReviewMs: 0,
      acceptanceRate: 0,
      totalCount: 0,
    }
  }

  const weekMap = new Map<string, { sumNed: number; count: number }>()
  const userMap = new Map<string, { sumNed: number; count: number }>()
  for (const pair of pairs) {
    const week = weekStart(pair.humanTs)
    const weekEntry = weekMap.get(week) ?? { sumNed: 0, count: 0 }
    weekEntry.sumNed += pair.ned
    weekEntry.count++
    weekMap.set(week, weekEntry)

    const userEntry = userMap.get(pair.author) ?? { sumNed: 0, count: 0 }
    userEntry.sumNed += pair.ned
    userEntry.count++
    userMap.set(pair.author, userEntry)
  }

  const byWeek = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, value]) => ({ weekStart: week, avgNed: value.sumNed / value.count, count: value.count }))
  const byUser = Array.from(userMap.entries())
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([author, value]) => ({ author, avgNed: value.sumNed / value.count, count: value.count }))

  return {
    pairs,
    byWeek,
    byUser,
    overallAvgNed: pairs.reduce((sum, pair) => sum + pair.ned, 0) / pairs.length,
    overallAvgReviewMs: pairs.reduce((sum, pair) => sum + pair.reviewTimeMs, 0) / pairs.length,
    acceptanceRate: pairs.filter((pair) => pair.acceptedAsIs).length / pairs.length,
    totalCount: pairs.length,
  }
}
