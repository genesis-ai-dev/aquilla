/**
 * POST batches to /events; groups by fileId for per-file sync JWT scope.
 */

import type { CqrsRawEvent } from "./outbox-types"
import {
  markOutboxAttempt,
  peekPendingOutboxBatch,
  quarantineOutboxEvents,
  removeOutboxEvents,
  type OutboxAttemptError,
  type OutboxRecord,
} from "./outbox"
import { syncWorkerHttpOrigin } from "./sync-worker-url"

const MAX_BATCH = 100

interface PostBody {
  accepted: Array<{ id: string }>
  rejected: Array<{ id: string; status: number; reason: string }>
  /** Chain-mutating events the server accepted (logged) but did NOT apply to
   *  the projection — stale siblings that had no visible effect. Surfaced so
   *  "accepted" is never silently mistaken for "saved". `fileId`/`cellId` are
   *  carried so the UI can deep-link the user to the cell's history drawer
   *  (where the stale commit is preserved as a branch off its parent). */
  stale?: Array<StaleSiblingEntry>
  /** F5: target.cell.commit events whose sourceEventId pin is stale — the
   *  source row advanced since the translator last fetched. Event was accepted
   *  and projected (LWW) but flagged so the UI can surface a banner. */
  staleSource?: Array<{ id: string; currentSourceEventId: string }>
}

export interface StaleSiblingEntry {
  id: string
  fileId: string | null
  cellId: string | null
}

export interface FlushDeps {
  /** Mint a sync-token scoped to the EVENT's own project + file — not the
   *  workspace's current project. The outbox is a single global store shared
   *  across every project the user has open; minting against the active
   *  workspace's projectId is what produced "403 token scoped to different
   *  project" on edits queued in another project, wedging the whole queue. */
  getTokenForFile: (projectId: string, fileId: string) => Promise<string | null>
  fetchImpl?: typeof fetch
  /** F5: called when one or more target.cell.commit events had a stale
   *  sourceEventId. The caller should surface a "source changed" hint. */
  onStaleSource?: (entries: Array<{ id: string; currentSourceEventId: string }>) => void
  /** F6: called when one or more events were dead-lettered as stale siblings.
   *  The caller passes the full entry list so the UI can deep-link the user
   *  to the first affected cell's history drawer. */
  onStaleSiblings?: (entries: StaleSiblingEntry[]) => void
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
  /** True when the token fetch returned null with rows actually queued — the
   *  flush could not proceed because auth (or the /sync-token endpoint) is
   *  unavailable. Distinct from `networkError` so the caller can back off
   *  on persistent auth failure without conflating "queue is empty". */
  authError: boolean
  /** Records moved to permanent `failed` status this flush because the server
   *  rejected them non-retryably (403). Surfaced so the caller can show an
   *  accurate "couldn't save — review" banner instead of "session expired". */
  quarantined: number
  staleSiblingCount: number
  staleSourceCount: number
}> {
  const fetchFn = deps.fetchImpl ?? fetch
  const records = await peekPendingOutboxBatch(MAX_BATCH * 2)
  if (records.length === 0) {
    return { posted: 0, accepted: 0, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }
  const batch = groupOldestFileFirst(records)
  const fileId = batch[0].event.fileId
  if (!fileId) {
    await removeOutboxEvents([batch[0].id])
    return { posted: 0, accepted: 0, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }
  const projectId = batch[0].event.projectId
  const token = await deps.getTokenForFile(projectId, fileId)
  if (!token) {
    return { posted: 0, accepted: 0, networkError: false, authError: true, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
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
    return { posted: events.length, accepted: 0, networkError: true, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }

  if (!res.ok) {
    // A whole-batch 403 is non-retryable (wrong project scope / role too low):
    // quarantine so the flusher advances to the next file instead of looping
    // on this one forever. 401 and 5xx remain transient (token re-mint / server
    // hiccup), so they keep their retry budget.
    if (res.status === 403) {
      await quarantineOutboxEvents(
        batch.map((r) => r.id),
        { status: 403, reason: `HTTP 403` },
      )
      return { posted: events.length, accepted: 0, networkError: false, authError: false, quarantined: batch.length, staleSiblingCount: 0, staleSourceCount: 0 }
    }
    await markOutboxAttempt(
      batch.map((r) => r.id),
      { error: { status: res.status, reason: `HTTP ${res.status}` } },
    )
    return { posted: events.length, accepted: 0, networkError: true, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }

  let body: PostBody
  try {
    body = (await res.json()) as PostBody
  } catch {
    await markOutboxAttempt(
      batch.map((r) => r.id),
      { error: { status: 0, reason: "malformed server response" } },
    )
    return { posted: events.length, accepted: 0, networkError: true, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }

  // Surface failures loudly instead of swallowing them. A rejected event
  // (bad shape, forbidden, server error) and a stale event (accepted but not
  // applied to the projection) both previously vanished without a trace — the
  // root of the "edits silently don't save" bug. These logs are the minimum
  // visible signal; the OutboxSyncIndicator reflects pending/failed counts.
  if (body.rejected && body.rejected.length > 0) {
    console.error("[outbox-flush] server REJECTED events:", body.rejected)
  }
  if (body.stale && body.stale.length > 0) {
    console.error(
      "[outbox-flush] server accepted but did NOT apply (stale siblings):",
      body.stale.map((s) => s.id),
    )
    // F6: surface stale sibling dead-letters to the caller so a toast can be
    // shown. The full entries (with fileId/cellId) flow through so the
    // caller can deep-link to the affected cells.
    deps.onStaleSiblings?.(body.stale)
  }
  // F5: surface stale-source pins to the caller so a "source changed" hint can appear.
  if (body.staleSource && body.staleSource.length > 0) {
    console.warn(
      "[outbox-flush] target.cell.commit events had stale sourceEventId pins:",
      body.staleSource.map((s) => s.id),
    )
    deps.onStaleSource?.(body.staleSource)
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

  // 403 = non-retryable (wrong project scope, or role too low). Quarantine
  // immediately rather than burning the retry budget and head-of-line blocking
  // the rest of the queue. The record is preserved for the inspector so the
  // user can see "couldn't save — permission" and discard it. 401 stays in the
  // normal retry path: it can be a transient token-mint/expiry blip that a
  // fresh token resolves.
  const rejectionByid = new Map<string, OutboxAttemptError>()
  for (const r of body.rejected ?? []) {
    rejectionByid.set(r.id, { status: r.status, reason: r.reason })
  }
  const forbiddenIds = (body.rejected ?? [])
    .filter((r) => r.status === 403 && !acceptedIds.has(r.id))
    .map((r) => r.id)
  for (const id of forbiddenIds) {
    await quarantineOutboxEvents([id], rejectionByid.get(id) ?? { status: 403, reason: "forbidden" })
  }
  const forbiddenSet = new Set(forbiddenIds)

  // Records the server kept-back (401 auth retry, or any record we can't tell
  // from `body` because the server didn't ack it explicitly) get their attempt
  // recorded so the inspector shows why they're sitting around.
  const keptBackIds: string[] = []
  const keptBackUpdates: Array<[string, OutboxAttemptError | null]> = []
  for (const r of batch) {
    if (acceptedIds.has(r.id)) continue
    if (permanentlyRejectedIds.has(r.id)) continue
    if (forbiddenSet.has(r.id)) continue
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
    authError: false,
    quarantined: forbiddenIds.length,
    staleSiblingCount: body.stale?.length ?? 0,
    staleSourceCount: body.staleSource?.length ?? 0,
  }
}
