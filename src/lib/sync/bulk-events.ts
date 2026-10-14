// Bulk event commit — the "bulk import-style" front door for a large set of
// ALREADY-BUILT events produced by one foreground action (AQU-1860).
//
// The outbox is the right path for incremental edits: durable, optimistic,
// retried, dead-lettered. It is the wrong path for a few thousand events minted
// in a single click, for two structural reasons:
//
//   1. Enqueueing is one IndexedDB write per event when the caller emits them
//      one at a time (`src/lib/dcs/delta.ts` applyDelta awaits each emitter).
//   2. The flusher uploads at most MAX_BATCH (100) events per POST, for the
//      OLDEST FILE ONLY (`outbox-flush.ts` groupOldestFileFirst), one POST per
//      account per drain round, with a 5 s base interval between cycles
//      (`useOutboxFlusher.ts` BASE_INTERVAL_MS).
//
// A Door43 release that changes several thousand verses across dozens of books
// therefore trickles in — the exact problem `POST /import` was built to solve
// for genesis imports (see bulk-import.ts). `bulkPostEvents` sends the same
// envelopes the outbox would have flushed straight to `POST /events` in large
// per-file chunks, with the bulk-import retry policy and progress callbacks.
//
// Two caller obligations, both inherited from bulkUploadSource:
//   - Mint DETERMINISTIC event ids. Nothing here is durable across a reload, so
//     a failure is recovered by re-running the action; the server's
//     INSERT OR IGNORE then dedupes what already landed.
//   - Gate the action on role before calling. This path skips the outbox's
//     client-side `canPerform` mirror; the server's authorize() stays
//     authoritative either way.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { CqrsRawEvent } from "./outbox-types"
import type { StaleSiblingEntry } from "./outbox-flush"

/** Events per request. The server refuses more than MAX_EVENTS_PER_REQUEST
 *  (500, `sync-worker/src/events/route.ts`) and internally commits them in
 *  BATCH_LIMIT-sized transactions, so this sits at half the cap: 2.5x the
 *  outbox's batch without pushing any single transaction long. */
export const BULK_EVENTS_CHUNK = 250
const BULK_EVENTS_ATTEMPTS = 3
const BULK_EVENTS_RETRY_DELAYS_MS = [200, 800] as const

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Cancelled")
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new Error("Cancelled"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** The subset of `POST /events`' response body this path acts on. */
interface EventsPostBody {
  rejected?: Array<{ id: string; status: number; reason: string }>
  stale?: StaleSiblingEntry[]
}

export interface BulkPostEventsArgs {
  /** Pre-built envelopes. Every one MUST carry a `fileId` — writes are
   *  file-scoped, so a chunk may never mix files (see below). */
  events: readonly CqrsRawEvent[]
  /** Mints a sync-token scoped to (projectId, fileId). */
  getToken: (fileId: string) => Promise<string | null>
  /** Fired after each chunk lands — drives the progress UI. */
  onProgress?: (posted: number, total: number) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface BulkPostEventsResult {
  /** Events the server accepted (a rejected or stale event still counts as
   *  posted — it reached the server). */
  posted: number
  /** Events refused inside an otherwise-200 response (role, scope, validation).
   *  Non-empty means part of the action did not land. */
  rejected: Array<{ id: string; status: number; reason: string }>
  /** Chain-mutating events the server logged but did NOT project — stale
   *  siblings whose parent was no longer the cell's head. Surfaced so "posted"
   *  is never mistaken for "applied". */
  stale: StaleSiblingEntry[]
}

/**
 * POST pre-built events straight to `/events` in bounded per-file chunks.
 *
 * Grouping by `fileId` is not an optimization — `authorize()` requires the
 * event's fileId to be among the token's `file` scopes, so one token can only
 * carry one file's events. Group order and within-group order are preserved, so
 * events that must be applied in sequence stay in sequence.
 *
 * Throws on a transport failure or a non-retryable whole-request status; the
 * caller surfaces that and the user re-runs the action.
 */
export async function bulkPostEvents(
  args: BulkPostEventsArgs,
): Promise<BulkPostEventsResult> {
  const total = args.events.length
  if (total === 0) return { posted: 0, rejected: [], stale: [] }

  const fetchFn = args.fetchImpl ?? fetch
  const url = `${syncWorkerHttpOrigin()}/events`

  const byFile = new Map<string, CqrsRawEvent[]>()
  for (const event of args.events) {
    const fileId = event.fileId
    if (!fileId) {
      throw new Error(`Cannot bulk-commit event ${event.id}: it carries no fileId.`)
    }
    const group = byFile.get(fileId)
    if (group) group.push(event)
    else byFile.set(fileId, [event])
  }

  const result: BulkPostEventsResult = { posted: 0, rejected: [], stale: [] }

  for (const [fileId, fileEvents] of byFile) {
    let token = await args.getToken(fileId)
    if (!token) {
      throw new Error(
        "Couldn't get an upload token — you may be signed out. Sign in and try again.",
      )
    }

    for (let offset = 0; offset < fileEvents.length; offset += BULK_EVENTS_CHUNK) {
      if (args.signal?.aborted) throw new Error("Cancelled")
      const chunk = fileEvents.slice(offset, offset + BULK_EVENTS_CHUNK)
      let lastError: Error | null = null

      for (let attempt = 0; attempt < BULK_EVENTS_ATTEMPTS; attempt++) {
        if (args.signal?.aborted) throw new Error("Cancelled")
        let response: Response | null = null
        try {
          response = await fetchFn(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ events: chunk }),
            ...(args.signal ? { signal: args.signal } : {}),
          })
        } catch (err) {
          if (args.signal?.aborted) throw new Error("Cancelled", { cause: err })
          const reason = err instanceof Error ? err.message : "network error"
          lastError = new Error(`Commit failed: ${reason}`, { cause: err })
        }

        if (response) {
          if (response.ok) {
            let body: EventsPostBody = {}
            try {
              body = (await response.json()) as EventsPostBody
            } catch {
              // An older/minimal server body is not a failure: the chunk was
              // accepted. We simply have no per-event detail to report.
            }
            if (body.rejected?.length) result.rejected.push(...body.rejected)
            if (body.stale?.length) result.stale.push(...body.stale)
            result.posted += chunk.length
            args.onProgress?.(result.posted, total)
            lastError = null
            break
          }

          const detail = await response.text().catch(() => "")
          lastError = new Error(
            `Commit failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          )

          // A long run can outlive the file token it started with. Refresh and
          // replay the same idempotent chunk once.
          if (response.status === 401 && attempt < BULK_EVENTS_ATTEMPTS - 1) {
            const refreshed = await args.getToken(fileId)
            if (refreshed) {
              token = refreshed
              continue
            }
          }
          if (!isRetryableStatus(response.status)) throw lastError
        }

        if (attempt < BULK_EVENTS_ATTEMPTS - 1) {
          await waitForRetry(BULK_EVENTS_RETRY_DELAYS_MS[attempt], args.signal)
        }
      }

      if (lastError) throw lastError
    }
  }

  return result
}
