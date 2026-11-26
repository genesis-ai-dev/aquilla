/**
 * Runs a project move (`planProjectMove`) through the existing team routes:
 * POST /orgs/:id/groups/:g/projects to put it in a folder, DELETE …/:projectId
 * to take it out. Attaches go first so the project is never in no folder
 * halfway through a move between two. Not atomic: a failure part-way is
 * reported and the page re-reads the tree, which then shows where it ended up.
 */
import { attachProject, detachProject } from "@/lib/frontier/teams"

import type { MovePlan } from "./folder-tree"

export async function applyProjectMove(jwt: string, orgId: number, projectId: string, plan: MovePlan): Promise<void> {
  for (const { folderId, roleLevel } of plan.attach) {
    await attachProject(jwt, orgId, Number(folderId), projectId, roleLevel)
  }
  for (const folderId of plan.detach) {
    await detachProject(jwt, orgId, Number(folderId), projectId)
  }
}
