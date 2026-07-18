// Best-effort bridge from identity-owned project settings to the existing
// per-project realtime room. Settings are durable in Postgres; this only
// eliminates the wait for a reconnect/focus refresh for active collaborators.

import type { ProjectDoServerMessage } from './project-do-handlers'

export interface ProjectSettingsNotifyEnv {
  ProjectSync?: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

export async function notifyProjectDoSettingsChanged(
  env: ProjectSettingsNotifyEnv,
  projectId: string,
  version: number,
): Promise<void> {
  if (!env.ProjectSync) throw new Error('ProjectSync DO not bound')
  const id = env.ProjectSync.idFromName(projectId)
  const stub = env.ProjectSync.get(id)
  const body: ProjectDoServerMessage = {
    t: 'project.settings.updated',
    project: projectId,
    version,
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
 * Handles identity's internal settings-change notification. The settings
 * write has already committed when this route runs, so notify failures must
 * not affect the durable write.
 */
export async function handleProjectSettingsChangedRequest(
  request: Request,
  env: ProjectSettingsNotifyEnv,
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(/^\/admin\/projects\/([^/]+)\/settings-changed$/)
  if (!match) return null
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })

  const expected = env.SYNC_SECRET_KEY ? `Bearer ${env.SYNC_SECRET_KEY}` : null
  if (!expected || request.headers.get('Authorization') !== expected) {
    return new Response('unauthorized', { status: 401 })
  }

  let body: { version?: unknown }
  try {
    body = await request.json() as { version?: unknown }
  } catch {
    return new Response('bad request', { status: 400 })
  }
  if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 0) {
    return new Response('version (non-negative integer) required', { status: 400 })
  }

  const projectId = decodeURIComponent(match[1])
  try {
    await notifyProjectDoSettingsChanged(env, projectId, body.version)
  } catch (err) {
    console.warn(`[project-settings] ProjectSync notify failed for ${projectId}:`, err)
  }
  return Response.json({ ok: true })
}
