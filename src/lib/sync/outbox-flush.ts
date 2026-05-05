/**
 * POST batches to /events; groups by fileId for per-file sync JWT scope.
 */

import type { CqrsRawEvent } from "./cqrs-types"
import {
  peekOutboxBatch,
  removeOutboxEvents,
  type OutboxRecord,
} from "./outbox"
import { syncWorkerHttpOrigin } from "./sync-worker-url"

const MAX_BATCH = 100

interface PostBody {
  accepted: Array<{ id: string }>
  rejected: Array<{ id: string; status: number; reason: string }>
}

export interface FlushDeps {
  getTokenForFile: (fileId: string) => Promise<string | null>
  fetchImpl?: typeof fetch
}

function groupOldestFileFirst(records: OutboxRecord[]): OutboxRecord[] {
  if (records.length === 0) return []
  const fid = records[0].event.fileId
  if (!fid) return records.slice(0, MAX_BATCH)
  const same: OutboxRecord[] = []
  const rest: OutboxRecord[] = []
  for (const r of records) {
    if (r.event.fileId === fid && same.length < MAX_BATCH) same.push(r)
    else rest.push(r)
  }
  return same
}

/**
 * Flush one batch: oldest slice grouped by file of the oldest row.
 * Returns accepted count (0 if nothing to send or no token).
 */
export async function flushOutboxBatch(deps: FlushDeps): Promise<{
  posted: number
  accepted: number
  networkError: boolean
}> {
  const fetchFn = deps.fetchImpl ?? fetch
  const records = await peekOutboxBatch(MAX_BATCH * 2)
  if (records.length === 0) {
    return { posted: 0, accepted: 0, networkError: false }
  }
  const batch = groupOldestFileFirst(records)
  const fileId = batch[0].event.fileId
  if (!fileId) {
    await removeOutboxEvents([batch[0].id])
    return { posted: 0, accepted: 0, networkError: false }
  }
  const token = await deps.getTokenForFile(fileId)
  if (!token) {
    return { posted: 0, accepted: 0, networkError: false }
  }
  const events: CqrsRawEvent[] = batch.map((r) => r.event)
  const url = `${syncWorkerHttpOrigin()}/events`
  let res: Response
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events }),
    })
  } catch {
    return { posted: events.length, accepted: 0, networkError: true }
  }

  if (!res.ok) {
    return { posted: events.length, accepted: 0, networkError: true }
  }

  let body: PostBody
  try {
    body = (await res.json()) as PostBody
  } catch {
    return { posted: events.length, accepted: 0, networkError: true }
  }

  const acceptedIds = (body.accepted ?? []).map((a) => a.id)
  const permanentlyRejectedIds = (body.rejected ?? [])
    .filter((r) => r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403)
    .map((r) => r.id)
  const removableIds = [...new Set([...acceptedIds, ...permanentlyRejectedIds])]
  if (removableIds.length > 0) {
    await removeOutboxEvents(removableIds)
  }

  return {
    posted: events.length,
    accepted: acceptedIds.length,
    networkError: false,
  }
}
