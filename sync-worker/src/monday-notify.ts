// Monday.com push notification — fired from the ProjectSync DO's __broadcast
// choke point (every applied event passes through it, HTTP and WS doors alike).
// Best-effort and throttled: identity's /api/v2/monday/internal/push endpoint
// owns the real debounce + dirty-flag logic; a missed notify is reconciled by
// identity's cron flush.

import type { ProjectDoServerMessage } from './project-do-handlers'
import { serviceBearerMatches } from './lib/service-auth'
import {
  isAbortTimeout,
  logVendorTimeout,
  VENDOR_TIMEOUT_MS,
} from '../../shared/vendor-timeouts'

export interface MondayNotifyEnv {
  /** Base URL of the identity worker (e.g. https://api.aquilla.app/identity). */
  AUTH_WORKER_URL?: string
  SYNC_SECRET_KEY?: string
}

export interface MondayLinkChangedEnv {
  ProjectSync?: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

/** Frame types that mean project content/progress may have changed. */
const CONTENT_FRAME_TYPES = new Set(['event.applied', 'file.progress.updated'])

/**
 * Pure classifier: does this broadcast batch imply progress may have changed,
 * and for which project? Returns the project id or null. Presence/lock/member
 * frames never trigger a push.
 */
export function mondayNotifyProject(messages: ProjectDoServerMessage[]): string | null {
  for (const msg of messages) {
    if (!CONTENT_FRAME_TYPES.has(msg.t)) continue
    const project = (msg as { project?: unknown }).project
    if (typeof project === 'string' && project !== '') return project
  }
  return null
}

/**
 * POST the project id to identity's internal Monday push endpoint. Swallows
 * every failure — Monday sync must never affect the live edit path.
 *
 * AQU-1828: resolves to identity's `linked` answer — `false` when the project
 * has no enabled Monday link, so the caller can stop nudging us for it, `true`
 * when it has one, and `null` when we could not find out (not configured, a
 * network failure, or an identity error). Only a definite `false` is worth
 * caching.
 */
export async function notifyMondayProgress(
  env: MondayNotifyEnv,
  projectId: string,
): Promise<boolean | null> {
  if (!env.AUTH_WORKER_URL || !env.SYNC_SECRET_KEY) return null
  try {
    const response = await fetch(`${env.AUTH_WORKER_URL}/api/v2/monday/internal/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId }),
      // AQU-1849: this fires from the DO's broadcast choke point, i.e. on the
      // live edit path, so a hung identity must not hold the invocation open.
      // Giving up is free here — identity's cron flush reconciles a missed
      // nudge — but the `null` it returns is NOT cached as "not linked", so a
      // timeout never silently stops Monday sync for the project.
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS.mondayPushNudge),
    })
    if (!response.ok) return null
    const body = await response.json() as { linked?: unknown }
    return typeof body.linked === 'boolean' ? body.linked : null
  } catch (err) {
    /* best-effort by design */
    if (isAbortTimeout(err)) logVendorTimeout('mondayPushNudge', err)
    return null
  }
}

/**
 * Tell the project's DO that its Monday link was created, reconfigured,
 * enabled/disabled or deleted, so it drops any cached "no link here" answer
 * and nudges identity again on the next edit.
 */
export async function notifyProjectDoMondayLinkChanged(
  env: MondayLinkChangedEnv,
  projectId: string,
): Promise<void> {
  if (!env.ProjectSync) throw new Error('ProjectSync DO not bound')
  const stub = env.ProjectSync.get(env.ProjectSync.idFromName(projectId))
  const response = await stub.fetch('http://do.internal/__monday-link-changed', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SYNC_SECRET_KEY}` },
  })
  if (!response.ok) throw new Error(`DO returned HTTP ${response.status}`)
}

/**
 * Handles identity's internal Monday-link-change notification. The link write
 * has already committed when this runs, so a notify failure must not fail the
 * request — a missed notify only costs the DO's backstop TTL.
 */
export async function handleMondayLinkChangedRequest(
  request: Request,
  env: MondayLinkChangedEnv,
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(
    /^\/admin\/projects\/([^/]+)\/monday-link-changed$/,
  )
  if (!match) return null
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!serviceBearerMatches(request.headers.get('Authorization'), env)) {
    return new Response('unauthorized', { status: 401 })
  }

  const projectId = decodeURIComponent(match[1])
  try {
    await notifyProjectDoMondayLinkChanged(env, projectId)
  } catch (err) {
    console.warn(`[monday] ProjectSync link-change notify failed for ${projectId}:`, err)
  }
  return Response.json({ ok: true })
}
