// Project-level notification for a completed bulk source import. The import
// route remains the authoritative database writer; this only fans the compact
// progress/file-inventory invalidation through the existing ProjectSync DO.

import type { ProjectDoServerMessage } from './project-do-handlers'

export interface ProjectProgressBroadcastEnv {
  ProjectSync?: DurableObjectNamespace
  SYNC_SECRET_KEY?: string
}

export async function notifyProjectDoFileProgressChanged(
  env: ProjectProgressBroadcastEnv,
  projectId: string,
  fileId: string,
  fileCreated: boolean,
): Promise<void> {
  if (!env.ProjectSync) throw new Error('ProjectSync DO not bound')
  const id = env.ProjectSync.idFromName(projectId)
  const stub = env.ProjectSync.get(id)
  const body: ProjectDoServerMessage = {
    t: 'file.progress.updated',
    project: projectId,
    file: fileId,
    fileCreated,
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
