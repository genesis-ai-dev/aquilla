// Monday.com push notification — fired from the ProjectSync DO's __broadcast
// choke point (every applied event passes through it, HTTP and WS doors alike).
// Best-effort and throttled: identity's /api/v2/monday/internal/push endpoint
// owns the real debounce + dirty-flag logic; a missed notify is reconciled by
// identity's cron flush.

import type { ProjectDoServerMessage } from './project-do-handlers'

export interface MondayNotifyEnv {
  /** Base URL of the identity worker (e.g. https://api.aquilla.app/identity). */
  AUTH_WORKER_URL?: string
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
 */
export async function notifyMondayProgress(env: MondayNotifyEnv, projectId: string): Promise<void> {
  if (!env.AUTH_WORKER_URL || !env.SYNC_SECRET_KEY) return
  try {
    await fetch(`${env.AUTH_WORKER_URL}/api/v2/monday/internal/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectId }),
    })
  } catch {
    /* best-effort by design */
  }
}
