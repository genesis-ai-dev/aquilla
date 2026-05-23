// Live broadcast of project-archive updates to the project DO. Kept in its own
// module so project-archive.ts stays pure and unit-testable without a DO runtime.

import type { ArchiveMarker, ProjectArchiveBroadcaster, ProjectArchiveEnv } from "./project-archive"
import type { ProjectDoServerMessage } from "./project-do-handlers"

export const notifyProjectDo: ProjectArchiveBroadcaster = async (
  env: ProjectArchiveEnv,
  projectId: string,
  marker: ArchiveMarker
): Promise<void> => {
  if (!env.ProjectSync) {
    throw new Error("ProjectSync DO not bound")
  }
  const id = env.ProjectSync.idFromName(projectId)
  const stub = env.ProjectSync.get(id)
  const body: ProjectDoServerMessage = {
    t: "project.archived",
    project: projectId,
    archivedAt: marker.archivedAt,
    deletedBy: marker.deletedBy,
  }
  const res = await stub.fetch("http://do.internal/__broadcast", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`DO returned HTTP ${res.status}`)
  }
}
