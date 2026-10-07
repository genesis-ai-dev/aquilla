// Long-poll "has this changeset moved yet?" for the Agent API (AQU-1177 §2).
//
// Before this, an agent that handed a human an approvalUrl had exactly one
// signal available: call get_changeset again, and again, and again. Agents
// either burned the lifecycle rate limit on a tight poll or slept so long that
// they noticed an approval minutes after it happened.
//
// WHAT COUNTS AS "MOVED" — the subtle part. A human approving does NOT change
// the changeset's status: auth-worker's approve route mints a row in
// `changeset_confirmations` and leaves the changeset `staged` until the agent
// commits it. So waiting on `status !== 'staged'` alone would sleep straight
// through the very event the agent is waiting for. The settle predicate is
// therefore two-armed:
//
//   • a live approval exists (unconsumed, unexpired confirmation) → the agent
//     should now call confirm_changeset; or
//   • the status left `staged` at all — rejected (`discarded`), committed by
//     someone else, expired, superseded, or found stale.
//
// This is a poll loop, not a subscription. The changeset engine is plain
// Postgres rows written by two different Workers (sync-worker stages/commits,
// auth-worker approves), with no shared Durable Object or LISTEN/NOTIFY channel
// between them, so there is nothing to subscribe to; a bounded server-side poll
// is what actually collapses the agent's latency from "its next poll interval"
// to about a second. It sleeps rather than spins, so it costs wall-clock, not
// CPU.

import { loadChangeset } from './store'
import type { StoredChangeset } from './types'

/** Default long-poll ceiling. Comfortably inside every proxy's idle timeout, so
 *  a caller that passes nothing gets a full wait rather than a severed socket. */
export const WAIT_DEFAULT_TIMEOUT_MS = 25_000

/** Hard ceiling on a caller-supplied timeout. A request may not pin a worker
 *  invocation open indefinitely just because the client asked nicely. */
export const WAIT_MAX_TIMEOUT_MS = 60_000

const WAIT_MIN_POLL_MS = 25
const WAIT_MAX_POLL_MS = 1_000

/** Clamp a caller-supplied timeout into `[0, WAIT_MAX_TIMEOUT_MS]`. A zero
 *  timeout is legal and useful: it means "tell me the current state, don't
 *  wait" — one round of the same predicate, no sleep. */
export function clampWaitTimeout(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return WAIT_DEFAULT_TIMEOUT_MS
  return Math.min(WAIT_MAX_TIMEOUT_MS, Math.floor(raw))
}

/** Poll cadence for a given budget: ~10 checks across the wait, held within
 *  [25ms, 1s]. A one-second ceiling is what makes "returns within seconds of a
 *  human approving" true; the floor keeps a short (test-sized) timeout from
 *  turning into a busy loop. */
function pollIntervalFor(timeoutMs: number): number {
  return Math.min(WAIT_MAX_POLL_MS, Math.max(WAIT_MIN_POLL_MS, Math.floor(timeoutMs / 10)))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** True when an unconsumed, unexpired human approval is on file for this
 *  changeset — i.e. commit would now get past the ask-mode gate. */
export async function hasLiveApproval(db: AquillaDb, changesetId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM changeset_confirmations
        WHERE changeset_id = ? AND consumed_at IS NULL AND expires_at > now()
        LIMIT 1`,
    )
    .bind(changesetId)
    .first<{ ok: number }>()
  return row != null
}

export interface WaitOutcome {
  changeset: StoredChangeset
  /** A live human approval is on file — call commit/confirm_changeset now. */
  approved: boolean
  /** The wait budget ran out before anything moved. `changeset` is still the
   *  freshly re-read row, so a caller can act on it without a second fetch. */
  timedOut: boolean
  waitedMs: number
}

/**
 * Block until this changeset is approved or leaves `staged`, or until
 * `timeoutMs` elapses — whichever comes first.
 *
 * Always evaluates the predicate ONCE before sleeping, so an already-settled
 * changeset (or a `timeoutMs` of 0) returns immediately. The final sleep is
 * trimmed to the remaining budget, so the call never overruns the timeout the
 * caller was promised.
 */
export async function waitForChangesetSettled(
  db: AquillaDb,
  projectId: string,
  changesetId: string,
  initial: StoredChangeset,
  timeoutMs: number,
): Promise<WaitOutcome> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  const interval = pollIntervalFor(timeoutMs)

  let cs = initial
  let approved = await hasLiveApproval(db, changesetId)

  while (!approved && cs.status === 'staged') {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(interval, remaining))
    // The row can vanish only if it was deleted outright, which nothing does;
    // keep the last-known row rather than inventing a not_found mid-wait.
    cs = (await loadChangeset(db, projectId, changesetId)) ?? cs
    approved = await hasLiveApproval(db, changesetId)
  }

  return {
    changeset: cs,
    approved,
    timedOut: !approved && cs.status === 'staged',
    waitedMs: Date.now() - startedAt,
  }
}
