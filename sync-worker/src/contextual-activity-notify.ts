// Best-effort bridge from the contextual translation pipeline (auth-worker's
// durable run) to the existing per-project realtime room. Mirrors
// project-settings-notify.ts: the run state is durable server-side; this only
// eliminates the wait for a snapshot refetch for already-connected clients.
// A dropped frame self-heals on the SPA's next `attachContextualRun` — the
// broadcast is a latency accelerator, never load-bearing.

import type { ProjectDoServerMessage } from './project-do-handlers'
import { parseContextualFrame, type ContextualFrame } from './contextual-frames'

export interface ContextualActivityNotifyEnv {
  ProjectSync?: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

export async function notifyProjectDoContextualActivity(
  env: ContextualActivityNotifyEnv,
  projectId: string,
  frame: ContextualFrame,
): Promise<void> {
  if (!env.ProjectSync) throw new Error('ProjectSync DO not bound')
  const id = env.ProjectSync.idFromName(projectId)
  const stub = env.ProjectSync.get(id)
  const body: ProjectDoServerMessage = {
    t: 'contextual.activity',
    project: projectId,
    frame,
  }
  const response = await stub.fetch('http://do.internal/__broadcast', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`DO returned HTTP ${response.status}`)
}

/**
 * Handles the pipeline's internal contextual-activity notification. The run
 * step that produced this frame has already committed when this route runs,
 * so notify failures must not affect the durable run — they are logged and
 * swallowed (the SPA re-hydrates from the snapshot on its own).
 */
export async function handleContextualActivityRequest(
  request: Request,
  env: ContextualActivityNotifyEnv,
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(/^\/admin\/projects\/([^/]+)\/contextual-activity$/)
  if (!match) return null
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })

  const expected = env.SYNC_SECRET_KEY ? `Bearer ${env.SYNC_SECRET_KEY}` : null
  if (!expected || request.headers.get('Authorization') !== expected) {
    return new Response('unauthorized', { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('bad request', { status: 400 })
  }
  const frame = parseContextualFrame(body)
  if (!frame) {
    return new Response('contextual frame (contextual.run.state | contextual.scene | contextual.span) required', { status: 400 })
  }

  const projectId = decodeURIComponent(match[1])
  try {
    await notifyProjectDoContextualActivity(env, projectId, frame)
  } catch (err) {
    console.warn(`[contextual-activity] ProjectSync notify failed for ${projectId}:`, err)
  }
  return Response.json({ ok: true })
}
