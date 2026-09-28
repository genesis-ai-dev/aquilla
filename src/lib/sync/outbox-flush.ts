/**
 * POST batches to /events; groups by fileId for per-file sync JWT scope.
 */

import type { CqrsRawEvent } from "./outbox-types"
import {
  markOutboxAttempt,
  getActiveOutboxOwnerVersion,
  getOutboxRecords,
  peekPendingOutboxBatch,
  quarantineOutboxEvents,
  removeOutboxEvents,
  stampOutboxError,
  type OutboxAttemptError,
  type OutboxOwnerScope,
  type OutboxRecord,
} from "./outbox"
import { syncWorkerHttpOrigin } from "./sync-worker-url"
import { parseAppliedEventFrame } from "./ws-reconciler"
import type { AppliedEventFrame } from "./live-apply"
import { timeoutSignal } from "./fetch-timeout"
import { observedSyncFetch, readSyncJson } from "./connection-activity"
import posthog from "@/lib/posthog"
import { OUTBOX_QUARANTINED } from "@/lib/event-names"

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
  /** One `event.applied`-shaped frame per committed event (same builder as
   *  the ProjectSync broadcast — carries `serverSeq` + the cell's projected
   *  `rows` for cell-content kinds). Absent on older servers and on the
   *  partial-commit path; the client then refetches as before. */
  applied?: unknown[]
}

export interface StaleSiblingEntry {
  id: string
  fileId: string | null
  cellId: string | null
}

/** AQU-633: an event the server refused with a 403 (non-retryable) and that the
 *  flusher quarantined. Carries the server's `reason` so the UI can tell the
 *  user WHY (e.g. "file '…' not in scope", "self-validation is not allowed")
 *  instead of silently reverting the optimistic change behind a bare "N failed"
 *  pill. `kind` lets the caller tailor copy per event type. */
export interface ForbiddenEntry {
  id: string
  status: number
  reason: string
  kind: string
  fileId: string | null
  cellId: string | null
}

/** An event the server refused with a non-retryable 4xx inside an otherwise
 *  successful (200) response — a shape the worker's validation would refuse
 *  every time, so the flusher drops it. Carries the server's `reason` and the
 *  `kind`/`fileId` the caller needs to revert the right optimistic state. */
export interface RejectedEntry {
  id: string
  kind: string
  status: number
  reason: string
  fileId: string | null
}

export interface FlushDeps {
  /** Mint a sync-token scoped to the EVENT's own project + file — not the
   *  workspace's current project. The outbox is a single global store shared
   *  across every project the user has open; minting against the active
   *  workspace's projectId is what produced "403 token scoped to different
   *  project" on edits queued in another project, wedging the whole queue. */
  getTokenForFile: (projectId: string, fileId: string) => Promise<TokenMintResult>
  /**
   * Background drains must name the account whose rows and credential they
   * carry. The exact stored session is checked before minting and again before
   * POST, so logout or JWT replacement cancels captured work without falling
   * through to whichever account happens to be active.
   */
  ownerScope?: OutboxOwnerScope & {
    isSessionCurrent: () => Promise<boolean>
    /** Only the active account may raise UI/identified telemetry. */
    shouldSurface?: () => boolean
  }
  fetchImpl?: typeof fetch
  /** F5: called when one or more target.cell.commit events had a stale
   *  sourceEventId. The caller should surface a "source changed" hint. */
  onStaleSource?: (entries: Array<{ id: string; currentSourceEventId: string }>) => void
  /** F6: called when one or more events were dead-lettered as stale siblings.
   *  The caller passes the full entry list so the UI can deep-link the user
   *  to the first affected cell's history drawer. */
  onStaleSiblings?: (entries: StaleSiblingEntry[]) => void
  /** Called with the server's `applied[]` frames (parsed) for the events this
   *  flush committed — the author's own write, projected. Also fans out to
   *  `subscribeAppliedEvents` listeners. */
  onApplied?: (frames: AppliedEventFrame[]) => void
  /** Called just before non-retryable 4xx rejections are dropped from the
   *  outbox. These arrive inside a 200 and used to disappear behind a
   *  console.error, so a refused write's optimistic UI simply reverted with no
   *  explanation — which reads to the user as the app randomly undoing their
   *  work. The caller uses this to revert deliberately and say why.
   *  Deliberately NOT routed through the 403 quarantine path: that copy is
   *  about permissions, and a refused shape is a bug, not a permission
   *  problem. */
  onRejected?: (entries: RejectedEntry[]) => void
  /** Called before a permanent 403 is quarantined. Foreground committers use
   *  the exact event ids to clear optimistic state and avoid chaining future
   *  writes onto a head the server refused.
   *
   *  AQU-1068: `onRejected` deliberately skips this class (see its note),
   *  which was fine while every optimistic write was a value edit a refetch
   *  would correct. It is not fine for a write that changes the SHAPE of the
   *  file: an optimistic insert or removal carries a freshness floor, so no
   *  correcting fetch can undo it, and the caller has to. A permission
   *  refusal is also the ONLY status the cell-editing gate ever returns, so a
   *  rollback wired to `onRejected` alone can never fire for the one case it
   *  exists for. */
  onForbidden?: (entries: ForbiddenEntry[]) => void
}

function forbiddenEntriesFor(
  records: OutboxRecord[],
  reason: string,
): ForbiddenEntry[] {
  return records.map((record) => ({
    id: record.id,
    status: 403,
    reason,
    kind: record.event.kind,
    fileId: record.event.fileId ?? null,
    cellId: record.event.cellId ?? null,
  }))
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

export type FlushOutboxResult = {
  posted: number
  accepted: number
  networkError: boolean
  /** True when the token fetch returned null with rows actually queued — the
   *  flush could not proceed because auth (or the /sync-token endpoint) is
   *  unavailable. Distinct from `networkError` so the caller can back off
   *  on persistent auth failure without conflating "queue is empty". */
  authError: boolean
  /** HTTP status from a failed token mint, when one was available. */
  authStatus?: number | null
  /** Records moved to permanent `failed` status this flush because the server
   *  rejected them non-retryably (403). Surfaced so the caller can show an
   *  accurate "couldn't save — review" banner instead of "session expired". */
  quarantined: number
  staleSiblingCount: number
  staleSourceCount: number
}

type StaleSiblingsListener = (entries: StaleSiblingEntry[]) => void
type AppliedListener = (frames: AppliedEventFrame[]) => void
const appliedListeners = new Set<AppliedListener>()

/**
 * Tab-wide notification of the `applied[]` frames a flush got back. Like
 * `subscribeStaleSiblings`: most inline "flush now" calls and the app-shell
 * drain never pass `onApplied`, so the workspace subscribes once and lands
 * every committed row into the active cell store — the same `liveApplier`
 * path a peer's `event.applied` echo takes — instead of a by-ids GET.
 * Listeners run BEFORE the flush promise resolves, so a committing handler
 * that awaits the flush sees the head already in the store.
 */
export function subscribeAppliedEvents(listener: AppliedListener): () => void {
  appliedListeners.add(listener)
  return () => { appliedListeners.delete(listener) }
}
const staleSiblingsListeners = new Set<StaleSiblingsListener>()

/**
 * Tab-wide stale-sibling notification. `deps.onStaleSiblings` only reaches
 * the caller that ran THIS flush, but a commit is usually posted by an inline
 * "flush now" call (e.g. right after a cell commit) that never passes the
 * callback — so a stale rejection of the user's own edit could go unseen by
 * the workspace that owns the optimistic shadow. Every flush notifies these
 * listeners (subject to the same `shouldSurface` gate) so the workspace can
 * treat stale as a rejection regardless of which caller posted the batch.
 */
export function subscribeStaleSiblings(listener: StaleSiblingsListener): () => void {
  staleSiblingsListeners.add(listener)
  return () => { staleSiblingsListeners.delete(listener) }
}

// Per-tab serialization. Many inline `flushOutboxBatch` calls run outside the
// Web Lock held by useOutboxFlusher, so two callers could peek the same
// pending rows and POST them twice. Callers queue behind the running flush;
// the queued run is a no-op when the earlier one drained the queue.
let flushChain: Promise<unknown> = Promise.resolve()

/**
 * Flush one batch: oldest slice grouped by file of the oldest row.
 * Returns accepted count (0 if nothing to send or no token).
 * Serialized per tab — see `flushChain`.
 */
export function flushOutboxBatch(deps: FlushDeps): Promise<FlushOutboxResult> {
  const run = flushChain.then(() => flushOutboxBatchUnserialized(deps))
  flushChain = run.catch(() => undefined)
  return run
}

/** Rounds `flushOutboxUntilSettled` will run before handing back to the
 *  background flusher. Each round posts at most MAX_BATCH events, so this
 *  drains up to 600 queued rows while still bounding a pathological queue. */
const MAX_SETTLE_ROUNDS = 6

export type FlushUntilSettledResult = FlushOutboxResult & {
  /** True when none of the requested events are `pending` in the outbox any
   *  more — each was accepted, dead-lettered or quarantined, so the caller's
   *  `onStaleSiblings`/`onRejected` bookkeeping has seen its final outcome. */
  settled: boolean
}

async function watchedEventsSettled(ids: readonly string[]): Promise<boolean> {
  if (ids.length === 0) return true
  const records = await getOutboxRecords(ids)
  return records.every((record) => record.status !== "pending")
}

/**
 * AQU-579: flush until *these* events have actually been posted.
 *
 * `flushOutboxBatch` posts one file group — the file of the OLDEST pending
 * row, capped at MAX_BATCH. A caller that enqueues a write and then flushes
 * once therefore has no guarantee its own events went out: any older pending
 * row for a different file (or a 100+ backlog on the same file) wins the
 * batch instead. The caller then observes no `stale[]`/rejection entries for
 * its events and reports success, while the events go out later under the
 * background flusher — where a dead-letter reaches only the tab-wide
 * `subscribeStaleSiblings` listener, which drops the optimistic shadow with
 * no rebase-and-retry. For an AI completion that is the reported data loss:
 * the progress bar finishes, the drafts render, and moments later the text
 * disappears with no error and no way back.
 *
 * Looping until the watched ids leave the pending queue keeps that outcome
 * inside the caller's own flush, so its existing rebase-retry sees it. The
 * loop stops early when a round posts nothing (no progress to be made) or the
 * transport is down; `settled: false` then means the background flusher owns
 * the rest, exactly as before this call existed.
 */
export async function flushOutboxUntilSettled(
  eventIds: readonly string[],
  deps: FlushDeps,
  opts: { maxRounds?: number } = {},
): Promise<FlushUntilSettledResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? MAX_SETTLE_ROUNDS)
  const watched = [...new Set(eventIds.filter(Boolean))]
  const total: FlushOutboxResult = {
    posted: 0,
    accepted: 0,
    networkError: false,
    authError: false,
    quarantined: 0,
    staleSiblingCount: 0,
    staleSourceCount: 0,
  }
  let settled = watched.length === 0
  for (let round = 0; round < maxRounds && !settled; round++) {
    const result = await flushOutboxBatch(deps)
    total.posted += result.posted
    total.accepted += result.accepted
    total.quarantined += result.quarantined
    total.staleSiblingCount += result.staleSiblingCount
    total.staleSourceCount += result.staleSourceCount
    // Transport flags describe the LAST round — an earlier transient failure
    // that a later round recovered from is not the caller's outcome.
    total.networkError = result.networkError
    total.authError = result.authError
    if (result.authStatus !== undefined) total.authStatus = result.authStatus
    settled = await watchedEventsSettled(watched)
    if (settled) break
    // Nothing posted, or the transport is down: another round would re-peek
    // the same rows and fail the same way.
    if (result.posted === 0 || result.networkError || result.authError) break
  }
  return { ...total, settled }
}

async function flushOutboxBatchUnserialized(deps: FlushDeps): Promise<FlushOutboxResult> {
  const ownerVersion = deps.ownerScope ? null : getActiveOutboxOwnerVersion()
  const outboxScope: OutboxOwnerScope | undefined = deps.ownerScope
    ? { ownerKey: deps.ownerScope.ownerKey }
    : undefined
  const isCredentialCurrent = async (): Promise<boolean> => {
    if (deps.ownerScope) return deps.ownerScope.isSessionCurrent()
    return ownerVersion === getActiveOutboxOwnerVersion()
  }
  const shouldSurface = (): boolean => deps.ownerScope?.shouldSurface?.() ?? true
  const fetchFn = deps.fetchImpl ?? fetch
  const records = await peekPendingOutboxBatch(MAX_BATCH * 2, outboxScope)
  if (records.length === 0 || !(await isCredentialCurrent())) {
    return { posted: 0, accepted: 0, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }
  const batch = groupOldestFileFirst(records)
  const fileId = batch[0].event.fileId
  if (!fileId) {
    // AQU-228: comment.* events with project scope carry no fileId in the
    // envelope (the scope lives in the payload). Historically these were
    // dropped here, silently discarding resolves/edits/deletes. For comment.*
    // kinds without a fileId we use a project-sentinel so the token fetcher
    // can mint a project-scoped sync-token — the server only checks projectId
    // for comment auth, not fileId. All other no-fileId events (legacy cell
    // events without an envelope fileId) are still dropped as before to prevent
    // them from wedging the queue.
    const isCommentKind = batch[0].event.kind.startsWith('comment.')
    if (!isCommentKind) {
      await removeOutboxEvents([batch[0].id], outboxScope)
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
  // Foreground mode fences account switches. Background mode instead fences
  // the exact owner/JWT pair, allowing an inactive account to drain while
  // still cancelling immediately when that stored credential is replaced or
  // removed.
  if (!(await isCredentialCurrent())) {
    return { posted: 0, accepted: 0, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }
  if (!mint.token) {
    // Token mint failed. Distinguish permanent from transient so a single
    // un-mintable file can't head-of-line block the rest of the queue (the
    // original wedge: any null token was treated as a transient auth blip,
    // retried forever, and the queue never advanced past the oldest event).
    if (mint.status === 403) {
      // No access to THIS event's project — e.g. it was queued under a
      // different account/role. Re-auth won't fix it. Quarantine the batch and
      // let the flusher advance to the next file, exactly like a 403 on POST.
      if (shouldSurface()) {
        deps.onForbidden?.(forbiddenEntriesFor(
          batch,
          "no access to this change's project",
        ))
        posthog.capture(OUTBOX_QUARANTINED, {
          count: batch.length,
          reason: "token-mint-403",
          project_id: projectId,
        })
      }
      await quarantineOutboxEvents(
        batch.map((r) => r.id),
        { status: 403, reason: "no access to this change's project" },
        outboxScope,
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
      outboxScope,
    )
    return { posted: 0, accepted: 0, networkError: false, authError: true, authStatus: mint.status, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
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
    res = await observedSyncFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events }),
      signal: timeoutSignal(15_000),
    }, fetchFn)
  } catch (err) {
    // RES-2: network throws (including AbortError/timeout) are transient — do NOT
    // burn the attempt budget. Use stampOutboxError (same policy as token-mint
    // failures) so the flusher can auto-recover when connectivity is restored.
    const isTimeout = err instanceof Error && err.name === "TimeoutError"
    const reason = isTimeout ? "request timed out" : (err instanceof Error ? err.message : "network error")
    await stampOutboxError(
      batch.map((r) => r.id),
      { status: 0, reason },
      outboxScope,
    )
    return { posted: events.length, accepted: 0, networkError: true, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }

  if (!res.ok) {
    // A whole-batch 403 is non-retryable (wrong project scope / role too low):
    // quarantine so the flusher advances to the next file instead of looping
    // on this one forever. 401 and 5xx are transient (token re-mint / server
    // hiccup) — RES-2: stamp error WITHOUT burning the retry budget.
    if (res.status === 403) {
      if (shouldSurface()) {
        deps.onForbidden?.(forbiddenEntriesFor(batch, "HTTP 403"))
        posthog.capture(OUTBOX_QUARANTINED, {
          count: batch.length,
          reason: "post-403",
          project_id: projectId,
        })
      }
      await quarantineOutboxEvents(
        batch.map((r) => r.id),
        { status: 403, reason: `HTTP 403` },
        outboxScope,
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
        outboxScope,
      )
      return { posted: events.length, accepted: 0, networkError: true, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
    }
    // RES-2: 5xx and 401 are transient — stamp without burning budget.
    await stampOutboxError(
      batch.map((r) => r.id),
      { status: res.status, reason: `HTTP ${res.status}` },
      outboxScope,
    )
    return { posted: events.length, accepted: 0, networkError: true, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 }
  }

  let body: PostBody
  try {
    body = await readSyncJson<PostBody>(res)
  } catch {
    await markOutboxAttempt(
      batch.map((r) => r.id),
      { error: { status: 0, reason: "malformed server response" } },
      outboxScope,
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
    if (shouldSurface()) {
      deps.onStaleSiblings?.(body.stale)
      for (const listener of staleSiblingsListeners) listener(body.stale)
    }
  }
  // F5: surface stale-source pins to the caller so a "source changed" hint can appear.
  if (body.staleSource && body.staleSource.length > 0) {
    console.warn(
      "[outbox-flush] target.cell.commit events had stale sourceEventId pins:",
      body.staleSource.map((s) => s.id),
    )
    if (shouldSurface()) deps.onStaleSource?.(body.staleSource)
  }

  const acceptedIds = new Set((body.accepted ?? []).map((a) => a.id))
  if (Array.isArray(body.applied) && body.applied.length > 0 && shouldSurface()) {
    const frames: AppliedEventFrame[] = []
    for (const raw of body.applied) {
      const frame = parseAppliedEventFrame(raw)
      if (frame) frames.push(frame)
    }
    if (frames.length > 0) {
      deps.onApplied?.(frames)
      for (const listener of appliedListeners) listener(frames)
    }
  }
  const permanentlyRejectedIds = new Set(
    (body.rejected ?? [])
      .filter((r) => r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403)
      .map((r) => r.id),
  )
  if (permanentlyRejectedIds.size > 0) {
    // Fired BEFORE the removal below, while the queued records still exist:
    // the server's `rejected` array carries only id/status/reason, so kind and
    // fileId have to be read back off the batch. Retrying is pointless (the
    // same shape fails the same way forever) so the events still go — the
    // caller just gets one chance to react before they do.
    const recordById = new Map(batch.map((r) => [r.id, r]))
    const rejectedEntries: RejectedEntry[] = []
    for (const r of body.rejected ?? []) {
      if (!permanentlyRejectedIds.has(r.id)) continue
      const record = recordById.get(r.id)
      rejectedEntries.push({
        id: r.id,
        kind: record?.event.kind ?? "unknown",
        status: r.status,
        reason: r.reason,
        fileId: record?.event.fileId ?? null,
      })
    }
    if (shouldSurface()) deps.onRejected?.(rejectedEntries)
  }

  const removableIds = [...acceptedIds, ...permanentlyRejectedIds]
  if (removableIds.length > 0) {
    await removeOutboxEvents(removableIds, outboxScope)
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
  if (forbiddenIds.length > 0) {
    if (shouldSurface()) {
      const forbiddenIdSet = new Set(forbiddenIds)
      const records = batch.filter((record) => forbiddenIdSet.has(record.id))
      deps.onForbidden?.(records.map((record) => ({
        id: record.id,
        status: 403,
        reason: rejectionByid.get(record.id)?.reason ?? "forbidden",
        kind: record.event.kind,
        fileId: record.event.fileId ?? null,
        cellId: record.event.cellId ?? null,
      })))
      posthog.capture(OUTBOX_QUARANTINED, {
        count: forbiddenIds.length,
        reason: "server-rejected-403",
        project_id: projectId,
      })
    }
  }
  for (const id of forbiddenIds) {
    await quarantineOutboxEvents(
      [id],
      rejectionByid.get(id) ?? { status: 403, reason: "forbidden" },
      outboxScope,
    )
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
      await markOutboxAttempt(ids, { error: err }, outboxScope)
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
