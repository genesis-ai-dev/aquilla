/**
 * POST batches to /events; groups by fileId for per-file sync JWT scope.
 */

import type { CqrsRawEvent } from "./cqrs-types"
import {
  markOutboxAttempt,
  peekOutboxBatch,
  removeOutboxEvents,
  type OutboxAttemptError,
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
  /** When set, only events whose envelope projectId matches are flushed.
   *  Without this guard a tab viewing project B tries to flush leftover
   *  events from project A using a token scoped to B, producing 403s. */
  projectId?: string
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
  const scoped = deps.projectId
    ? records.filter((r) => r.event.projectId === deps.projectId)
    : records
  if (scoped.length === 0) {
    return { posted: 0, accepted: 0, networkError: false }
  }
  const batch = groupOldestFileFirst(scoped)
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
  } catch (err) {
    const reason = err instanceof Error ? err.message : "network error"
    await markOutboxAttempt(
      batch.map((r) => r.id),
      { error: { status: 0, reason } },
    )
    return { posted: events.length, accepted: 0, networkError: true }
  }

  if (!res.ok) {
    await markOutboxAttempt(
      batch.map((r) => r.id),
      { error: { status: res.status, reason: `HTTP ${res.status}` } },
    )
    return { posted: events.length, accepted: 0, networkError: true }
  }

  let body: PostBody
  try {
    body = (await res.json()) as PostBody
  } catch {
    await markOutboxAttempt(
      batch.map((r) => r.id),
      { error: { status: 0, reason: "malformed server response" } },
    )
    return { posted: events.length, accepted: 0, networkError: true }
  }

  const acceptedIds = new Set((body.accepted ?? []).map((a) => a.id))
  const permanentlyRejectedIds = new Set(
    (body.rejected ?? [])
      .filter((r) => r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403)
      .map((r) => r.id),
  )
  const removableIds = [...acceptedIds, ...permanentlyRejectedIds]
  if (removableIds.length > 0) {
    await removeOutboxEvents(removableIds)
  }

  // Records the server kept-back (401/403 auth quarantine, or any record we
  // can't tell from `body` because the server didn't ack it explicitly) get
  // their attempt recorded so the inspector shows why they're sitting around.
  const rejectionByid = new Map<string, OutboxAttemptError>()
  for (const r of body.rejected ?? []) {
    rejectionByid.set(r.id, { status: r.status, reason: r.reason })
  }
  const keptBackIds: string[] = []
  const keptBackUpdates: Array<[string, OutboxAttemptError | null]> = []
  for (const r of batch) {
    if (acceptedIds.has(r.id)) continue
    if (permanentlyRejectedIds.has(r.id)) continue
    keptBackIds.push(r.id)
    keptBackUpdates.push([r.id, rejectionByid.get(r.id) ?? null])
  }
  if (keptBackIds.length > 0) {
    // Group by error so we can mark in shared transactions where possible.
    const byErr = new Map<string, { err: OutboxAttemptError | null; ids: string[] }>()
    for (const [id, err] of keptBackUpdates) {
      const key = err ? `${err.status}|${err.reason}` : "_none_"
      let bucket = byErr.get(key)
      if (!bucket) {
        bucket = { err, ids: [] }
        byErr.set(key, bucket)
      }
      bucket.ids.push(id)
    }
    for (const { err, ids } of byErr.values()) {
      await markOutboxAttempt(ids, { error: err })
    }
  }

  return {
    posted: events.length,
    accepted: acceptedIds.size,
    networkError: false,
  }
}
