/**
 * POST batches to /events; groups by fileId for per-file sync JWT scope.
 */

import type { CqrsRawEvent } from "./outbox-types"
import {
  markOutboxAttempt,
  peekPendingOutboxBatch,
  quarantineOutboxEvents,
  removeOutboxEvents,
  stampOutboxError,
  type OutboxAttemptError,
  type OutboxRecord,
} from "./outbox"
import { syncWorkerHttpOrigin } from "./sync-worker-url"
import { timeoutSignal } from "./fetch-timeout"

const MAX_BATCH = 100

/**
 * Result of minting a sync token for the flusher. Unlike the `string | null`
 * fetcher used elsewhere, the flusher needs the HTTP `status` of a failed mint
 * so it can tell a *permanent* failure (403 — no access to this event's
 * project; re-auth won't help) from a *transient* one (401 stale JWT / 5xx /
 * offline). Collapsing both to a bare `null` is what let a single un-mintable
 * event head-of-line block the entire queue.
 *
 *   token != null            → mint succeeded
 *   token == null, status=403 → permanent: quarantine the batch and advance
 *   token == null, status=401 → stale JWT: keep retryable, self-heals on re-auth
 *   token == null, status=other/null → transient: keep retryable, back off
 */
export interface TokenMintResult {
  token: string | null
  status: number | null
}

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
  getTokenForFile: (projectId: string, fileId: string) => Promise<TokenMintResult>
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
  // BLOCKER 2 fix: when the head record has no fileId (project-scoped comment.* event),
  // only include other no-fileId comment.* records from the same project in the batch.
  // This prevents mixing sentinel-token events with file-scoped events, which caused
  // the file-scoped siblings to 403 ("token scoped to different file") and get
  // permanently quarantined even though they were perfectly valid events.
  if (!fid) {
    const headProjectId = records[0].event.projectId
    const batch: OutboxRecord[] = []
    for (const r of records) {
      if (!r.event.fileId && r.event.projectId === headProjectId && batch.length < MAX_BATCH) {
        batch.push(r)
      }
    }
    return batch
  }
  const same: OutboxRecord[] = []
  for (const r of records) {
    if (r.event.fileId === fid && same.length < MAX_BATCH) same.push(r)
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
    // FRO-228: comment.* events with project scope carry no fileId in the
    // envelope (the scope lives in the payload). Historically these were
    // dropped here, silently discarding resolves/edits/deletes. For comment.*
    // kinds without a fileId we use a project-sentinel so the token fetcher
    // can mint a project-scoped sync-token — the server only checks projectId
    // for comment auth, not fileId. All other no-fileId events (legacy cell
    // events without an envelope fileId) are still dropped as before to prevent
    // them from wedging the queue.
    const isCommentKind = batch[0].event.kind.startsWith('comment.')
    if (!isCommentKind) {
      await removeOutboxEvents([batch[0].id])
      return { posted: 0, accepted: 0, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
    }
    // Fall through with a sentinel fileId so the flusher can mint a token.
    // The sentinel is never sent to the server — it's only for /sync-token.
  }
  const projectId = batch[0].event.projectId
  // For comment.* events without a fileId, use a sentinel that the identity
  // server accepts (any non-empty string; the sync-worker ignores fileId on
  // comment auth). Events WITH a fileId always use their own for correct scope.
  const tokenFileId = fileId ?? '__project__'
  const mint = await deps.getTokenForFile(projectId, tokenFileId)
  if (!mint.token) {
    // Token mint failed. Distinguish permanent from transient so a single
    // un-mintable file can't head-of-line block the rest of the queue (the
    // original wedge: any null token was treated as a transient auth blip,
    // retried forever, and the queue never advanced past the oldest event).
    if (mint.status === 403) {
      // No access to THIS event's project — e.g. it was queued under a
      // different account/role. Re-auth won't fix it. Quarantine the batch and
      // let the flusher advance to the next file, exactly like a 403 on POST.
      await quarantineOutboxEvents(
        batch.map((r) => r.id),
        { status: 403, reason: "no access to this change's project" },
      )
      return { posted: 0, accepted: 0, networkError: false, authError: false, quarantined: batch.length, staleSiblingCount: 0, staleSourceCount: 0 }
    }
    // 401 (stale JWT — self-heals on re-auth) or transient (5xx / offline /
    // no session). Stamp the reason so the inspector surfaces it instead of a
    // bland "Pending", but DON'T burn the retry budget — these recover on their
    // own. Still report authError so the flusher backs off rather than spinning.
    await stampOutboxError(
      batch.map((r) => r.id),
      mint.status
        ? { status: mint.status, reason: `couldn't get a sync token (HTTP ${mint.status})` }
        : { status: 0, reason: "no active session" },
    )
    return { posted: 0, accepted: 0, networkError: false, authError: true, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }
  const token = mint.token
  const events: CqrsRawEvent[] = batch.map((r) => r.event)
  const url = `${syncWorkerHttpOrigin()}/events`
  let res: Response
  try {
    // RES-6: 15s hard timeout so a hung connection doesn't strand the flusher.
    // AbortError is caught below and treated as transient (no budget burn).
    // Feature-detected (B3): AbortSignal.timeout is missing on older WebKit —
    // calling it unconditionally threw here BEFORE the fetch, bricking writes.
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events }),
      signal: timeoutSignal(15_000),
    })
  } catch (err) {
    // RES-2: network throws (including AbortError/timeout) are transient — do NOT
    // burn the attempt budget. Use stampOutboxError (same policy as token-mint
    // failures) so the flusher can auto-recover when connectivity is restored.
    const isTimeout = err instanceof Error && err.name === "TimeoutError"
    const reason = isTimeout ? "request timed out" : (err instanceof Error ? err.message : "network error")
    await stampOutboxError(
      batch.map((r) => r.id),
      { status: 0, reason },
    )
    return { posted: events.length, accepted: 0, networkError: true, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }

  if (!res.ok) {
    // A whole-batch 403 is non-retryable (wrong project scope / role too low):
    // quarantine so the flusher advances to the next file instead of looping
    // on this one forever. 401 and 5xx are transient (token re-mint / server
    // hiccup) — RES-2: stamp error WITHOUT burning the retry budget.
    if (res.status === 403) {
      await quarantineOutboxEvents(
        batch.map((r) => r.id),
        { status: 403, reason: `HTTP 403` },
      )
      return { posted: events.length, accepted: 0, networkError: false, authError: false, quarantined: batch.length, staleSiblingCount: 0, staleSourceCount: 0 }
    }
    // N1: any other whole-request 4xx (400/404/413/422…) is deterministic —
    // the same batch fails the same way forever, so it must burn the retry
    // budget (markOutboxAttempt) and surface as `failed` at the cap instead
    // of looping invisibly. 401 stays transient: a fresh token can fix it.
    if (res.status >= 400 && res.status < 500 && res.status !== 401) {
      await markOutboxAttempt(
        batch.map((r) => r.id),
        { error: { status: res.status, reason: `HTTP ${res.status}` } },
      )
      return { posted: events.length, accepted: 0, networkError: true, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
    }
    // RES-2: 5xx and 401 are transient — stamp without burning budget.
    await stampOutboxError(
      batch.map((r) => r.id),
      { status: res.status, reason: `HTTP ${res.status}` },
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
