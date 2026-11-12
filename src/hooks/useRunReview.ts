/**
 * useRunReview — one run's pending drafts with their QA findings, for the
 * PR-style run view: header counts, passage notability, and the Checks tab
 * (docs/superpowers/specs/2026-09-30-agent-pr-threads-design.md).
 *
 * Plain useState + race-guarded useEffect (AD-3 read pattern). Refetches when
 * the run's durable record moves (`updatedAt`, `proposedDrafts`), which is how
 * the Team list already learns about new staging.
 */

import { useEffect, useState } from "react"
import { fetchContextualDrafts, type ContextualDraftRecord, type ContextualRunRecord } from "@/lib/contextual/transport"
import { summarizeFindings } from "@/lib/agent/draft-findings"

export interface RunReview {
  drafts: ContextualDraftRecord[]
  pending: number
  flagged: number
  needsHuman: number
  /** Passages holding a draft triaged "needs you". */
  needsHumanSpans: ReadonlySet<string>
  loading: boolean
}

const EMPTY: RunReview = { drafts: [], pending: 0, flagged: 0, needsHuman: 0, needsHumanSpans: new Set(), loading: false }

export function runReviewOf(drafts: ContextualDraftRecord[]): Omit<RunReview, "loading"> {
  const reviews = drafts.map((d) => d.review ?? { findings: [], triage: null, severity: 0 })
  const { flagged, needsHuman } = summarizeFindings(reviews)
  const needsHumanSpans = new Set(
    drafts.flatMap((d) => (d.review?.triage === "human" && d.spanLabel ? [d.spanLabel] : [])),
  )
  return { drafts, pending: drafts.length, flagged, needsHuman, needsHumanSpans }
}

export function useRunReview(projectId: string, run: ContextualRunRecord | null): RunReview {
  const [review, setReview] = useState<RunReview>(EMPTY)
  const runId = run?.runId ?? null
  const fileId = run?.fileId ?? null
  const lane = run?.targetLang ?? ""
  const version = `${run?.updatedAt ?? ""}:${run?.proposedDrafts ?? 0}`

  useEffect(() => {
    if (!runId || !fileId) {
      setReview(EMPTY)
      return
    }
    let cancelled = false
    setReview((current) => ({ ...current, loading: true }))
    fetchContextualDrafts(projectId, fileId, lane)
      .then((drafts) => {
        if (cancelled) return
        setReview({ ...runReviewOf(drafts.filter((d) => d.runId === runId)), loading: false })
      })
      .catch(() => {
        // Counts are a convenience over the review surface, which reports its
        // own load errors; a failed read here just shows no counts.
        if (!cancelled) setReview(EMPTY)
      })
    return () => { cancelled = true }
  }, [projectId, runId, fileId, lane, version])

  return review
}
