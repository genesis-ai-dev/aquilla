/**
 * Runs a project move (`planProjectMove`) through the existing team routes:
 * POST /orgs/:id/groups/:g/projects to put it in a folder, DELETE …/:projectId
 * to take it out. Attaches go first so the project is never in no folder
 * halfway through a move between two. Not atomic: a failure part-way is
 * reported and the page re-reads the tree, which then shows where it ended up.
 */
import { attachProject, detachProject, getTeam } from "@/lib/frontier/teams"

import type { FolderAttachment, MovePlan } from "./folder-tree"

/**
 * The attachments with each folder's language limit on the project, read
 * from the folder itself (the tree payload does not carry it). A folder
 * limited to some languages must keep that limit wherever the project goes,
 * or a move would hand its people languages they never had. Throws when a
 * folder cannot be read or no longer holds the project: the caller then
 * moves nothing.
 */
export async function withLaneSelections(
  jwt: string,
  orgId: number,
  projectId: string,
  attachments: readonly FolderAttachment[],
): Promise<FolderAttachment[]> {
  return Promise.all(attachments.map(async (attachment) => {
    const team = await getTeam(jwt, orgId, Number(attachment.folderId))
    const held = team.projects.find((p) => p.id === projectId)
    if (!held) throw new Error(`folder ${attachment.folderId} no longer holds project ${projectId}`)
    return held.lanesExplicit ? { ...attachment, laneIds: held.laneIds ?? [] } : attachment
  }))
}

export async function applyProjectMove(jwt: string, orgId: number, projectId: string, plan: MovePlan): Promise<void> {
  for (const { folderId, roleLevel, laneIds } of plan.attach) {
    await attachProject(jwt, orgId, Number(folderId), projectId, roleLevel, laneIds)
  }
  for (const folderId of plan.detach) {
    await detachProject(jwt, orgId, Number(folderId), projectId)
  }
}
