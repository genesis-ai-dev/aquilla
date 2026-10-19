/**
 * apiRev 7: "check on project open" for manifest actions with `onOpen: true`
 * (a live-linked importer's "Check for updates").
 *
 * Runs client-side, in the browser of a member who opens the project — never
 * on a server (generated code never executes next to secrets). An action is
 * due when:
 *   - the user may perform every write scope the extension declares (an
 *     importer's write:files is a project lead's), AND already holds all of
 *     them in their standing grant — an on-open run never surprises anyone
 *     with a permission prompt;
 *   - it has not run for this user, project and action in the last day.
 * The last-run time is a per-browser convenience (localStorage).
 */

import { roleAllowsScope } from "./permissions"
import type { ToolScope } from "../../../shared/tools/manifest"

export const ON_OPEN_INTERVAL_MS = 24 * 60 * 60 * 1000

interface ToolLike {
  id: string
  grantedScopes: readonly ToolScope[]
  manifest: { scopes: readonly ToolScope[]; actions?: readonly { id: string; onOpen?: boolean }[] }
}

function key(username: string, projectId: string, toolId: string, actionId: string): string {
  return `aquilla.extensions.onOpen.v1:${username}:${projectId}:${toolId}:${actionId}`
}

function lastRun(username: string, projectId: string, toolId: string, actionId: string): number {
  try {
    const raw = window.localStorage.getItem(key(username, projectId, toolId, actionId))
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export function markOnOpenRun(args: { username: string; projectId: string; toolId: string; actionId: string; now: number }): void {
  try {
    window.localStorage.setItem(key(args.username, args.projectId, args.toolId, args.actionId), String(args.now))
  } catch {
    // Private mode: the check simply runs again next open.
  }
}

export function dueOnOpenActions(
  tools: readonly ToolLike[],
  ctx: { username: string; projectId: string; roleLevel: number | null; now: number },
): { toolId: string; actionId: string }[] {
  const due: { toolId: string; actionId: string }[] = []
  for (const tool of tools) {
    const actions = (tool.manifest.actions ?? []).filter((a) => a.onOpen)
    if (actions.length === 0) continue
    const declared = tool.manifest.scopes
    if (!declared.every((s) => roleAllowsScope(s, ctx.roleLevel) && tool.grantedScopes.includes(s))) continue
    for (const a of actions) {
      if (ctx.now - lastRun(ctx.username, ctx.projectId, tool.id, a.id) >= ON_OPEN_INTERVAL_MS) due.push({ toolId: tool.id, actionId: a.id })
    }
  }
  return due
}
