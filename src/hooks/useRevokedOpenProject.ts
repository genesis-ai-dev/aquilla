import { useEffect, useState } from "react"

import type { ProjectLoadStatus } from "@/hooks/useProject"
import { isLostProjectAccess } from "@/lib/sync/lost-project-access"
import { acknowledgeOutboxEvents, type OutboxRecord } from "@/lib/sync/outbox"

/**
 * AQU-2455: the open editor has lost the project. True from the first
 * lost-access refusal, a `member.removed` frame, or a later 403 on a project
 * that had already resolved in this visit. Stays true after those records are
 * acknowledged, so the refusal screen does not fall back into the editor.
 * A project counts as open only after a non-provisional resolve, so a cold
 * 403 keeps the ordinary refusal screen.
 */
export function useRevokedOpenProject(args: {
  projectId: string | null
  /** Ready, and not the directory's provisional paint. */
  settled: boolean
  status: ProjectLoadStatus
  /** This user's live `member.removed` frame for `projectId`. */
  ejected: boolean
  records: readonly OutboxRecord[]
}): boolean {
  // Remember which projects resolved for real during this visit. Adjusted
  // while rendering so a refusal on that same visit is not missed, and so a
  // cold 403 (never settled) does not take the mid-session path.
  const [settledIds, setSettledIds] = useState<ReadonlySet<string>>(() => new Set())
  if (args.settled && args.projectId && !settledIds.has(args.projectId)) {
    const next = new Set(settledIds)
    next.add(args.projectId)
    setSettledIds(next)
  }
  const hadSettled =
    args.projectId != null && (args.settled || settledIds.has(args.projectId))

  const lostNow = args.records.some(
    (record) =>
      args.projectId != null &&
      record.event.projectId === args.projectId &&
      isLostProjectAccess(record.lastError?.reason),
  )
  const shouldEnd = hadSettled && (lostNow || args.ejected || args.status === "forbidden")

  const [endedFor, setEndedFor] = useState<string | null>(null)
  if (shouldEnd && args.projectId && endedFor !== args.projectId) {
    setEndedFor(args.projectId)
  }
  const ended = endedFor === args.projectId

  useEffect(() => {
    if (!ended || !args.projectId) return
    const ids = args.records
      .filter(
        (record) =>
          record.event.projectId === args.projectId &&
          isLostProjectAccess(record.lastError?.reason),
      )
      .map((record) => record.id)
    if (ids.length > 0) void acknowledgeOutboxEvents(ids)
  }, [ended, args.projectId, args.records])

  return ended || shouldEnd
}
