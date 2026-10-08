/**
 * "Revert everything this tool did since T" — the executing half. Plans with
 * the pure planner (shared/tools/revert.ts) over the server's activity read,
 * then emits the compensating events through the ordinary outbox.
 */

import { emitCellUnvalidate, emitTargetCellCommits, type CellCommitInput } from "@/lib/sync/events-emit"
import { planToolRevert, type RevertPlan } from "../../../shared/tools/revert"
import type { ToolActivity } from "./tools-api"

export interface RevertOutcome {
  plan: RevertPlan
  restored: number
  unvalidated: number
}

export function planFromActivity(activity: ToolActivity): RevertPlan {
  return planToolRevert(activity.writes, activity.cells)
}

export async function executeToolRevert(args: {
  projectId: string
  toolId: string
  sinceMs: number
  author: string
  plan: RevertPlan
  flush: () => void
}): Promise<RevertOutcome> {
  const { plan } = args
  const commits: CellCommitInput[] = plan.commits.map((c) => ({
    projectId: args.projectId,
    fileId: c.fileId,
    cellId: c.cellId,
    parentId: c.parentId,
    sourceEventId: c.sourceEventId,
    ...(c.targetLang ? { targetLang: c.targetLang } : {}),
    ...(c.laneId ? { laneId: c.laneId } : {}),
    value: c.value,
    ...(c.valueHtml !== null ? { valueHtml: c.valueHtml } : {}),
    author: args.author,
    revertOfTool: { toolId: args.toolId, sinceMs: args.sinceMs },
  }))
  if (commits.length > 0) await emitTargetCellCommits(commits)
  for (const u of plan.unvalidates) {
    await emitCellUnvalidate({
      projectId: args.projectId,
      fileId: u.fileId,
      cellId: u.cellId,
      editEventId: u.editEventId,
      ...(u.targetLang ? { targetLang: u.targetLang } : {}),
      ...(u.laneId ? { laneId: u.laneId } : {}),
      author: args.author,
      surface: "batch",
    })
  }
  if (commits.length > 0 || plan.unvalidates.length > 0) args.flush()
  return { plan, restored: commits.length, unvalidated: plan.unvalidates.length }
}
