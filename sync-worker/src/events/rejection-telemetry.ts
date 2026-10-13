// AQU-1902 follow-up: make per-event server failures inside a 200 /events
// response visible in PostHog Logs.
//
// WHY: POST /events answers 200 with a per-event `rejected[]`. A batch that
// fails in Postgres reports every event as `{status: 500, reason: "DB batch
// failed"}` inside that 200, and the request wrapper in index.ts only ships
// responses with status >= 400 — so this whole class of failure (AQU-1900:
// lane-less target writes; AQU-1884: lane-less validations) never reached
// PostHog. The only trace was a console.error line in Workers Logs, with no
// project or kind on it.
//
// WHAT IS SHIPPED, per request, one log line per (project, kind, status,
// reason) group of rejections with status >= 500:
//   project id, event kind, status, the server's own reason string, the
//   group's count, the request's 5xx total and event count, and — for a batch
//   failure — the Postgres SQLSTATE code plus the table/column it names.
// Never cell text, payloads, usernames or the pg error message (a message can
// quote a value; the code, table and column cannot).
//
// FLOOD CONTROL: the SPA outbox retries a 5xx on a timer, so one stuck event
// re-fails every few seconds. Each group key ships at most once per
// THROTTLE_MS per isolate; the occurrences in between are counted and ride on
// the next line as `events.suppressed_since_last`. The key map is bounded.

import { shipLog, type PosthogLogEnv } from '../posthog-logs'

export const REJECTION_TELEMETRY_THROTTLE_MS = 60_000
const MAX_TRACKED_KEYS = 256
const MAX_REASON_LENGTH = 120

export interface RejectionForTelemetry {
  id: string
  status: number
  reason: string
}

export interface EventForTelemetry {
  id?: unknown
  kind?: unknown
  projectId?: unknown
}

/** Postgres error fields that name no user data. */
export interface DbFailureInfo {
  code?: string
  table?: string
  column?: string
}

export interface ServerRejectionGroup {
  projectId: string
  kind: string
  status: number
  reason: string
  count: number
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** Group a request's 5xx rejections by (project, kind, status, reason). */
export function summarizeServerRejections(
  events: readonly EventForTelemetry[],
  rejected: readonly RejectionForTelemetry[],
): ServerRejectionGroup[] {
  const byId = new Map<string, EventForTelemetry>()
  for (const event of events) {
    if (typeof event?.id === 'string') byId.set(event.id, event)
  }
  const groups = new Map<string, ServerRejectionGroup>()
  for (const entry of rejected) {
    if (entry.status < 500) continue
    const event = byId.get(entry.id)
    const projectId = str(event?.projectId, '(unknown)')
    const kind = str(event?.kind, '(unknown)')
    const reason = entry.reason.slice(0, MAX_REASON_LENGTH)
    const key = `${projectId}\u0000${kind}\u0000${entry.status}\u0000${reason}`
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { projectId, kind, status: entry.status, reason, count: 1 })
  }
  return [...groups.values()]
}

/** The SQLSTATE code and the table/column a pg error names — never its message. */
export function dbFailureInfo(err: unknown): DbFailureInfo {
  if (err === null || typeof err !== 'object') return {}
  const e = err as { code?: unknown; table?: unknown; column?: unknown }
  const pick = (v: unknown): string | undefined =>
    typeof v === 'string' && /^[A-Za-z0-9_.]{1,63}$/.test(v) ? v : undefined
  return { code: pick(e.code), table: pick(e.table), column: pick(e.column) }
}

const lastShipped = new Map<string, { at: number; suppressed: number }>()

function groupKey(group: ServerRejectionGroup): string {
  return `${group.projectId}\u0000${group.kind}\u0000${group.status}\u0000${group.reason}`
}

/**
 * Ship one log line per new 5xx rejection group, throttled per key. Returns
 * the lines it shipped (for tests); the promises go to `waitUntil` so the
 * response is never held, and failures are swallowed by shipLog.
 */
export function reportServerRejections(
  env: PosthogLogEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  events: readonly EventForTelemetry[],
  rejected: readonly RejectionForTelemetry[],
  dbFailure: DbFailureInfo | null = null,
  now: number = Date.now(),
): ServerRejectionGroup[] {
  const groups = summarizeServerRejections(events, rejected)
  if (groups.length === 0) return []
  const requestTotal = groups.reduce((sum, group) => sum + group.count, 0)
  const shipped: ServerRejectionGroup[] = []
  for (const group of groups) {
    const key = groupKey(group)
    const last = lastShipped.get(key)
    if (last && now - last.at < REJECTION_TELEMETRY_THROTTLE_MS) {
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
      'error',
      `events rejected ${group.status}: ${group.kind} — ${group.reason}`,
      {
        'events.project_id': group.projectId,
        'events.kind': group.kind,
        'events.status': group.status,
        'events.reason': group.reason,
        'events.rejected_count': group.count,
        'events.request_rejected_5xx': requestTotal,
        'events.request_event_count': events.length,
        'events.suppressed_since_last': suppressed,
        'db.error_code': dbFailure?.code,
        'db.table': dbFailure?.table,
        'db.column': dbFailure?.column,
      },
    )
    if (ctx) ctx.waitUntil(promise)
    else void promise
  }
  return shipped
}

/** Test seam. */
export function resetRejectionTelemetryForTests(): void {
  lastShipped.clear()
}
