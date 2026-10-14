// AQU-1965: make stale-sibling dead-letters inside a 200 /events response
// visible in PostHog Logs.
//
// WHY: a chain-mutating cell event that loses its AD-2 arbitration (the
// `chain_claims` slot, or the `cells.event_id = parentId` head CAS) is still
// logged and still answered `200 accepted` — it just never advances the
// projection. The route reports it in the response's `stale[]` so the client
// can drop its optimistic shadow and surface the banner (AQU-668/1154), but
// the SERVER keeps no trace at all: `rejection-telemetry.ts` only ships
// `rejected[]` entries with status >= 500, and a stale sibling is neither
// rejected nor 5xx. So a cell whose chain is poisoned — every commit on it
// losing, forever, with the user watching their edit revert — is invisible
// to operations, and the only way to find one was a partner telling us
// (AQU-1965: Marathi BSB cell 23).
//
// WHAT IS SHIPPED, per request, one log line per (project, file, cell, kind)
// group of stale siblings:
//   project / file / cell id, event kind, the dropped event id, the parent id
//   it chained on, the group's count, and the request's stale + event totals.
// Event and cell ids are UUIDs; the parent id is the pin the client keeps
// re-using, which is the whole diagnostic. Never cell text, payloads or
// usernames.
//
// FLOOD CONTROL: deliberately keyed by CELL, because repetition on one cell is
// the signal. Each key ships at most once per THROTTLE_MS per isolate and the
// occurrences in between ride on the next line as
// `events.suppressed_since_last` — a poisoned cell is the one whose count
// keeps climbing, while an ordinary two-writer race ships once and stops. The
// key map is bounded.

import { shipLog, type PosthogLogEnv } from '../posthog-logs'

export const STALE_SIBLING_TELEMETRY_THROTTLE_MS = 60_000
const MAX_TRACKED_KEYS = 256

/** One entry of the response's `stale[]` array. */
export interface StaleSiblingForTelemetry {
  id: string
  fileId: string | null
  cellId: string | null
}

/** The request's raw events, for the kind/project/parent of a stale entry. */
export interface EventForStaleTelemetry {
  id?: unknown
  kind?: unknown
  projectId?: unknown
  parentId?: unknown
}

export interface StaleSiblingGroup {
  projectId: string
  fileId: string
  cellId: string
  kind: string
  /** The last dropped event id in the group — one example, not the set. */
  eventId: string
  /** The parent that example chained on: the pin that lost. */
  parentId: string
  count: number
}

const UNKNOWN = '(unknown)'

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** Group a request's stale siblings by (project, file, cell, kind). */
export function summarizeStaleSiblings(
  events: readonly EventForStaleTelemetry[],
  stale: readonly StaleSiblingForTelemetry[],
): StaleSiblingGroup[] {
  const byId = new Map<string, EventForStaleTelemetry>()
  for (const event of events) {
    if (typeof event?.id === 'string') byId.set(event.id, event)
  }
  const groups = new Map<string, StaleSiblingGroup>()
  for (const entry of stale) {
    const event = byId.get(entry.id)
    const projectId = str(event?.projectId, UNKNOWN)
    const kind = str(event?.kind, UNKNOWN)
    const fileId = str(entry.fileId, UNKNOWN)
    const cellId = str(entry.cellId, UNKNOWN)
    const key = `${projectId}\u0000${fileId}\u0000${cellId}\u0000${kind}`
    const group = groups.get(key)
    if (group) {
      group.count += 1
      group.eventId = entry.id
      group.parentId = str(event?.parentId, UNKNOWN)
    } else {
      groups.set(key, {
        projectId,
        fileId,
        cellId,
        kind,
        eventId: entry.id,
        parentId: str(event?.parentId, UNKNOWN),
        count: 1,
      })
    }
  }
  return [...groups.values()]
}

const lastShipped = new Map<string, { at: number; suppressed: number }>()

function groupKey(group: StaleSiblingGroup): string {
  return `${group.projectId}\u0000${group.fileId}\u0000${group.cellId}\u0000${group.kind}`
}

/**
 * Ship one log line per new stale-sibling group, throttled per cell. Returns
 * the lines it shipped (for tests); the promises go to `waitUntil` so the
 * response is never held, and failures are swallowed by shipLog.
 */
export function reportStaleSiblings(
  env: PosthogLogEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  events: readonly EventForStaleTelemetry[],
  stale: readonly StaleSiblingForTelemetry[],
  now: number = Date.now(),
): StaleSiblingGroup[] {
  const groups = summarizeStaleSiblings(events, stale)
  if (groups.length === 0) return []
  const requestTotal = groups.reduce((sum, group) => sum + group.count, 0)
  const shipped: StaleSiblingGroup[] = []
  for (const group of groups) {
    const key = groupKey(group)
    const last = lastShipped.get(key)
    if (last && now - last.at < STALE_SIBLING_TELEMETRY_THROTTLE_MS) {
      last.suppressed += group.count
      continue
    }
    const suppressed = last?.suppressed ?? 0
    if (!last && lastShipped.size >= MAX_TRACKED_KEYS) {
      const oldest = lastShipped.keys().next().value
      if (oldest !== undefined) lastShipped.delete(oldest)
    }
    lastShipped.delete(key)
    lastShipped.set(key, { at: now, suppressed: 0 })
    shipped.push(group)
    const promise = shipLog(
      env,
      'aquilla-sync-worker',
      'warn',
      `events accepted but not applied (stale sibling): ${group.kind}`,
      {
        'events.project_id': group.projectId,
        'events.file_id': group.fileId,
        'events.cell_id': group.cellId,
        'events.kind': group.kind,
        'events.stale_event_id': group.eventId,
        'events.stale_parent_id': group.parentId,
        'events.stale_count': group.count,
        'events.request_stale': requestTotal,
        'events.request_event_count': events.length,
        'events.suppressed_since_last': suppressed,
      },
    )
    if (ctx) ctx.waitUntil(promise)
    else void promise
  }
  return shipped
}

/** Test seam. */
export function resetStaleSiblingTelemetryForTests(): void {
  lastShipped.clear()
}
